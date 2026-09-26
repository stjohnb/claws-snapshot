# CI builds through the `runtime` target on every push that touches this file
# or deploy/** (see the docker-build job in .github/workflows/ci.yml), so the
# secret-scanning RUN blocks below and the zsh smoke test actually execute
# before merge, not only on `main` via release.yml.
ARG CLAWS_SESSION_SHELL_IMAGE=ghcr.io/st-john-software/claws-session-shell@sha256:7e25fc170a74828a6620c17186516c466222d43f644019d55c8244a136db7627

# ── Build stage ───────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS builder

WORKDIR /src

# Install build-time deps for better-sqlite3 / node-pty native modules
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# better-sqlite3 13 and node-pty 1.1 ship no prebuilt binary, so npm always
# runs `node-gyp rebuild`. Left alone, node-gyp first downloads the Node
# headers tarball from nodejs.org — a fetch with no timeout, which on
# 2026-09-04 left two release builds asleep in node-gyp for 6 hours (#2862).
# The base image already carries the matching headers under
# /usr/local/include/node, so compile against those and never fetch.
ENV npm_config_nodedir=/usr/local

# esbuild's postinstall writes its native binary then immediately execs it to
# verify; under BuildKit/overlayfs this intermittently fails with ETXTBSY
# ("text file busy"). Retry to absorb that race (#1745). The `timeout` is the
# backstop for #2862: a stall becomes exit 124, which the retry can absorb.
RUN set -e; \
    test -f /usr/local/include/node/node.h && test -f /usr/local/include/node/common.gypi \
      || { echo "node headers are not at /usr/local/include/node — npm_config_nodedir is wrong for this base image" >&2; exit 1; }; \
    ok=0; \
    for i in 1 2 3; do \
      echo "npm ci attempt $i"; \
      s=0; \
      timeout --kill-after=30s 600s npm ci || s=$?; \
      if [ "$s" = 0 ]; then ok=1; break; fi; \
      if [ "$s" = 124 ] || [ "$s" = 137 ]; then \
        echo "attempt $i exceeded the 10m timeout and was killed (native-module build stall?)" >&2; \
      else \
        echo "attempt $i failed with exit $s, cleaning node_modules and retrying after 3s..." >&2; \
      fi; \
      rm -rf node_modules; \
      sleep 3; \
    done; \
    [ "$ok" = 1 ] || { echo "npm ci failed after 3 attempts" >&2; exit 1; }

COPY tsconfig.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src

# Stamps the release tag into the built image so CLAWS_SESSION_IMAGE
# defaults correctly; release.yml passes the real tag as a build arg.
ARG CLAWS_VERSION=dev
RUN echo "export const VERSION = \"$CLAWS_VERSION\";" > src/version.ts

RUN npm run build \
 && npm prune --omit=dev

# ── Shared shell source stage ─────────────────────────────────────────
# Published by St-John-Software/nixos-config#411. Keep this as the source of
# truth for zsh/git/SSH defaults; the final Claws image remains the app runtime.
# Source commit: 8458c8a7a41cf7c4e4ef97f53e7f7837f5a7f256.
FROM ${CLAWS_SESSION_SHELL_IMAGE} AS session-shell

# Extract with Debian tools independently of the upstream user and Nix database.
# The complete source store retains every transitive shell dependency.
FROM node:26-bookworm-slim AS session-shell-defaults
USER root
COPY --from=session-shell /nix/store /nix/store
COPY --from=session-shell /home/brendan /home/brendan

# Home Manager embeds its build user's home, including in configurations
# sourced by store path. Adapt the private runtime copy as well; this store
# is used without a Nix database or subsequent Nix operations.
RUN set -e; \
    mkdir -p /claws-skel; \
    cp -aL /home/brendan/. /claws-skel/; \
    chmod -R u+rwX /claws-skel; \
    grep -rIlZ '/home/brendan' /claws-skel /nix/store > /tmp/claws-home-files; \
    xargs -0 -r sed -i 's|/home/brendan|/home/claws|g' < /tmp/claws-home-files; \
    if grep -rIl '/home/brendan' /claws-skel /nix/store; then exit 1; fi; \
    test -f /claws-skel/.zshrc; \
    test -f /claws-skel/.ssh/config; \
    grep -Eiq 'Host[[:space:]]+(nas|ryzen|brendans-macbook-pro)' /claws-skel/.ssh/config; \
    forbidden='sirius|\.sde|cpartifactory|BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|known_hosts|kubeconfig|KUBECONFIG|ghp_|github_pat_|sk-[A-Za-z0-9]'; \
    if grep -RIE "$forbidden" /claws-skel; then exit 1; fi; \
    if find /claws-skel \( -name 'known_hosts*' -o -name 'id_rsa*' -o -name 'id_dsa*' \
      -o -name 'id_ecdsa*' -o -name 'id_ed25519*' -o -name '*kubeconfig*' -o -name '.netrc' \
      -o -name '*.pem' -o -name '*.p12' -o -name '*.pfx' -o -name '*.key' -o -name '*.sde' \
      -o -name '.kube' -o -name '.gnupg' -o -name '.aws' \) -print | grep .; then exit 1; fi; \
    grep -RhoE "/nix/store/[0-9a-z]{32}-[^[:space:]\"'\\)]+" /claws-skel | sort -u > /tmp/claws-skel-store-paths; \
    if xargs -r grep -RIE "$forbidden" < /tmp/claws-skel-store-paths; then exit 1; fi

# The whole store ships to the runtime image, not only the paths /claws-skel
# references, so scan all of it. The patterns are deliberately narrower than
# $forbidden above: a package closure legitimately contains the words
# `known_hosts` (zsh's ssh completion), `kubeconfig` and `sk-…` (`disk-utils`),
# so those become name-based checks here while the content scan keeps the
# patterns that cannot match ordinary nixpkgs output. The PEM BEGIN marker is
# checked separately, anchored to the start of a line: shared-mime-info's
# freedesktop.org.xml legitimately embeds
# `-----BEGIN PGP PRIVATE KEY BLOCK-----` mid-line as a MIME magic-byte
# signature for detecting PGP key files, not an actual key — a real PEM file
# always starts its BEGIN line at column 0.
RUN set -e; \
    store_forbidden='sirius|cpartifactory|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}'; \
    if grep -rIE "$store_forbidden" /nix/store; then exit 1; fi; \
    if grep -rIE '^-----BEGIN (OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY' /nix/store; then exit 1; fi; \
    if find /nix/store \( -name 'known_hosts*' -o -name 'id_rsa' -o -name 'id_dsa' \
      -o -name 'id_ecdsa' -o -name 'id_ed25519' -o -name '*kubeconfig*' -o -name '.netrc' \
      -o -name '*.sde' -o -name '.kube' -o -name '.gnupg' -o -name '.aws' \) -print | grep .; then exit 1; fi

# Export the package profile's executable links, retaining the store targets.
# Fail on a missing/ambiguous profile instead of silently dropping shell tools.
RUN set -e; \
    set -- /nix/store/*-home-manager-path; \
    test "$#" -eq 1; \
    test -d "$1/bin"; \
    mkdir -p /claws-shell-profile; \
    cp -a "$1/bin" /claws-shell-profile/bin

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

# Runtime binaries claws shells out to:
#   git          — clone/worktree operations
#   tmux         — interactive session backing store
#   openssh-client — runner SSH
#   gh           — GitHub CLI (token injected via env per-call)
#   jq, sqlite3, curl, ca-certificates — ancillary scripting
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux zsh openssh-client ca-certificates curl jq sqlite3 tini util-linux \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

ARG KUBECTL_VERSION=v1.31.4
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && curl -fsSL -o /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" \
 && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl && rm /tmp/kubectl.sha256

# AI CLIs. Claude is required; Codex / OpenCode are soft-failed because
# upstream package renames happen frequently and we don't want releases
# to break for an optional fallback provider. release.yml passes
# CLAUDE_CODE_VERSION and CODEX_VERSION with the versions it resolved from
# npm; `latest` is only the default for local/manual builds.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && (npm install -g @openai/codex@${CODEX_VERSION} || echo "codex install failed — soft fail") \
 && (npm install -g opencode-ai@latest || echo "opencode install failed — soft fail")

RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && useradd -m -u 1000 -s /bin/bash claws

COPY --from=session-shell-defaults /claws-skel /etc/skel
COPY --from=session-shell-defaults /nix/store /nix/store
COPY --from=session-shell-defaults /claws-shell-profile /opt/claws/shell-profile
# Keep the Node runtime and Debian tools first. Session startup prepends its
# authentication shim to this inherited PATH.
ENV PATH="${PATH}:/opt/claws/shell-profile/bin"

RUN set -e; \
    test -f /etc/skel/.zshrc; \
    zsh -n /etc/skel/.zshrc; \
    test -f /etc/skel/.ssh/config; \
    grep -Eiq 'Host[[:space:]]+(nas|ryzen|brendans-macbook-pro)' /etc/skel/.ssh/config; \
    forbidden='sirius|\.sde|cpartifactory|BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY|known_hosts|kubeconfig|KUBECONFIG|ghp_|github_pat_|sk-[A-Za-z0-9]'; \
    if grep -RIE "$forbidden" /etc/skel; then exit 1; fi; \
    if find /etc/skel \( -name 'known_hosts*' -o -name 'id_rsa*' -o -name 'id_dsa*' \
      -o -name 'id_ecdsa*' -o -name 'id_ed25519*' -o -name '*kubeconfig*' -o -name '.netrc' \
      -o -name '*.pem' -o -name '*.p12' -o -name '*.pfx' -o -name '*.key' -o -name '*.sde' \
      -o -name '.kube' -o -name '.gnupg' -o -name '.aws' \) -print | grep .; then exit 1; fi; \
    if find /nix/store \( -name 'known_hosts*' -o -name 'id_rsa' -o -name 'id_dsa' \
      -o -name 'id_ecdsa' -o -name 'id_ed25519' -o -name '*kubeconfig*' -o -name '.netrc' \
      -o -name '*.sde' -o -name '.kube' -o -name '.gnupg' -o -name '.aws' \) -print | grep .; then exit 1; fi; \
    test ! -e /home/brendan; \
    smoke_home=/home/claws; \
    cp -a /etc/skel/. "$smoke_home/"; \
    chown -R 1000:1000 "$smoke_home"; \
    if ! runuser -u claws -- env HOME="$smoke_home" zsh -i -c 'set -e; \
      test "$(id -u)" = 1000; \
      test "$HISTFILE" = "$HOME/.zsh_history"; touch "$HISTFILE"; \
      test -n "$EDITOR"; command -v "$EDITOR" >/dev/null; \
      command -v "$(git var GIT_EDITOR)" >/dev/null; \
      for tool in vim fzf eza; do command -v "$tool" >/dev/null; done; \
      test "$(command -v node)" = /usr/local/bin/node' > /tmp/claws-zsh-startup.log 2>&1; then cat /tmp/claws-zsh-startup.log; exit 1; fi; \
    if [ -s /tmp/claws-zsh-startup.log ]; then cat /tmp/claws-zsh-startup.log; exit 1; fi; \
    runuser -u claws -- env HOME="$smoke_home" sh -c 'for file in "$HOME/.zshrc" "$HOME/.ssh/config"; do printf "\n# edit smoke test\n" >> "$file"; done'; \
    test ! -e /home/brendan; \
    rm -rf "$smoke_home"

WORKDIR /opt/claws
COPY --from=builder --chown=claws:claws /src/dist ./dist
COPY --from=builder --chown=claws:claws /src/node_modules ./node_modules
COPY --from=builder --chown=claws:claws /src/package.json ./package.json
COPY --chown=claws:claws .skills /opt/claws/deploy/skills
COPY --chown=claws:claws --chmod=0755 deploy/install-skills.sh deploy/container-entrypoint.sh /opt/claws/deploy/

# Ensure the data dir is writable by the non-root user even before a
# PVC mounts over it (k8s fsGroup handles the mount case).
RUN mkdir -p /home/claws/.claws \
 && chown -R claws:claws /home/claws

USER claws
ENV HOME=/home/claws \
    PORT=3000 \
    CLAWS_BIND_HOST=0.0.0.0 \
    NODE_ENV=production \
    CLAWS_RUNTIME=container \
    # The npm prefix above is root-owned, so uid 1000 can never write to it and
    # the CLI's self-updater always fails (#3088). The image pins the CLI
    # version instead, and claude-code-release.yml's daily check publishes new versions.
    # Session pods and headless agent runs inherit this from the image.
    # Codex has no equivalent env var, so Claws instead disables its startup
    # update check in every config.toml it writes
    # (check_for_update_on_startup = false, #3312).
    DISABLE_AUTOUPDATER=1

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["/opt/claws/deploy/container-entrypoint.sh"]

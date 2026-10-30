# CI builds through the `runtime` target on every push that touches this file
# or deploy/** (see the docker-build job in .forgejo/workflows/ci.yml), so the
# secret-scanning RUN blocks below and the zsh smoke test actually execute
# before merge, not only on `main` via release.yml.
ARG CLAWS_SESSION_SHELL_IMAGE=registry.home.bstjohn.net/st-john-software/claws-session-shell:latest

# ── Build stage ───────────────────────────────────────────────────────
FROM node:26.12.1-bookworm-slim AS builder

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
ENV npm_package_config_node_gyp_nodedir=/usr/local

# esbuild's postinstall writes its native binary then immediately execs it to
# verify; under BuildKit/overlayfs this intermittently fails with ETXTBSY
# ("text file busy"). Retry to absorb that race (#1745). The `timeout` is the
# backstop for #2862: a stall becomes exit 124, which the retry can absorb.
RUN set -e; \
    test -f /usr/local/include/node/node.h && test -f /usr/local/include/node/common.gypi \
      || { echo "node headers are not at /usr/local/include/node — npm_package_config_node_gyp_nodedir is wrong for this base image" >&2; exit 1; }; \
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
# Source commit: c63fd990 (nixos-config "Post-cutover SSH aliases, records and
# Samba clean-up (6/7) (#32)").
FROM ${CLAWS_SESSION_SHELL_IMAGE} AS session-shell

# Extract with Debian tools independently of the upstream user and Nix database.
# The complete source store retains every transitive shell dependency.
FROM node:26.12.1-bookworm-slim AS session-shell-defaults
USER root
# All of /nix, not only the store: /nix/var/nix/registration is the Nix
# database registration the runtime stage loads. Copying the parent keeps a
# session shell that lacks it buildable up to the guard below, which names the fix.
COPY --from=session-shell /nix /nix
COPY --from=session-shell /home/brendan /home/brendan

# Home Manager embeds its build user's home, including in configurations
# sourced by store path. Adapt the private runtime copy as well. This edits
# registered store paths in place, so their contents no longer match the
# hashes in /nix/var/nix/registration: `nix store verify --check-contents`
# would fail, and nothing may run `nix-collect-garbage`, which would delete
# paths the runtime image depends on.
RUN set -e; \
    mkdir -p /claws-skel; \
    cp -aL /home/brendan/. /claws-skel/; \
    chmod -R u+rwX /claws-skel; \
    # Pods have no D-Bus or /etc/machine-id, so the desktop libsecret credential
    # helper only prints a glib CRITICAL; Claws passes its own helper per URL.
    if [ -f /claws-skel/.config/git/config ]; then sed -i '/^[[:space:]]*helper[[:space:]]*=.*libsecret/d' /claws-skel/.config/git/config; fi; \
    if grep -rIq libsecret /claws-skel/.config/git /claws-skel/.gitconfig 2>/dev/null; then echo "libsecret still in skel git config" >&2; exit 1; fi; \
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
#
# One benign allowance: nixpkgs cracklib installs its plain-text dictionary
# `cracklib-small` and the packed `pw_dict.{hwm,pwd,pwi}` under
# `share/cracklib/`. The word list contains dictionary words such as `sirius`.
# `--exclude-dir=cracklib` skips only directories with that exact basename, so
# every other store path is still scanned. Added in #263 after run 887 matched
# the word list. The self-test below proves the scan still bites outside it.
RUN set -e; \
    store_forbidden='sirius|cpartifactory|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}'; \
    store_scan() { grep -rIE --exclude-dir=cracklib "$store_forbidden" "$@"; }; \
    selftest=$(mktemp -d); \
    mkdir -p "$selftest/plain" "$selftest/share/cracklib"; \
    echo 'Host sirius' > "$selftest/plain/ssh_config"; \
    echo 'sirius' > "$selftest/share/cracklib/cracklib-small"; \
    store_scan "$selftest" > /tmp/store-scan-selftest || true; \
    if [ "$(wc -l < /tmp/store-scan-selftest)" -ne 1 ] || ! grep -q '/plain/ssh_config' /tmp/store-scan-selftest; then \
      echo "error: store secret scan self-test failed (planted string missed or cracklib allowance too broad)" >&2; \
      cat /tmp/store-scan-selftest >&2; exit 1; \
    fi; \
    rm -rf "$selftest" /tmp/store-scan-selftest; \
    if store_scan /nix/store; then exit 1; fi; \
    if grep -rIE '^-----BEGIN (OPENSSH|RSA|EC|DSA|PGP) PRIVATE KEY' /nix/store; then exit 1; fi; \
    if find /nix/store \( -name 'known_hosts*' -o -name 'id_rsa' -o -name 'id_dsa' \
      -o -name 'id_ecdsa' -o -name 'id_ed25519' -o -name '*kubeconfig*' -o -name '.netrc' \
      -o -name '*.sde' -o -name '.kube' -o -name '.gnupg' -o -name '.aws' \) -print | grep .; then exit 1; fi

# fleet-infra's image-scan scans the copied store. Nix gh duplicated the apt gh
# in the runtime stage, and gitleaks 8.30.1 pins vulnerable Go modules with no
# fixed release, so neither may ship. Fail here rather than in the fleet-infra
# scan if the published session shell regresses.
RUN if find /nix/store -maxdepth 1 \( -name '*-gh-[0-9]*' -o -name '*-gitleaks-[0-9]*' \) -print | grep .; then \
      echo "error: session shell store contains gh or gitleaks; fleet-infra image-scan will fail (fix nixos-config home/common.nix clawsSession)" >&2; \
      exit 1; \
    fi

# Export the package profile's executable links, retaining the store targets.
# Fail on a missing/ambiguous profile instead of silently dropping shell tools.
RUN set -e; \
    set -- /nix/store/*-home-manager-path; \
    test "$#" -eq 1; \
    test -d "$1/bin"; \
    mkdir -p /claws-shell-profile; \
    cp -a "$1/bin" /claws-shell-profile/bin

# Agent pods run single-user Nix (no daemon) from this profile over the copied
# store, so each repo's flake devShell works (clw_01M5WMKGESZQKEGQW0T8V91MBW).
RUN if [ ! -e /claws-shell-profile/bin/nix ] || [ ! -f /nix/var/nix/registration ]; then \
      echo "error: session shell lacks bin/nix or /nix/var/nix/registration (update St-John-Software/nixos-config home/common.nix clawsSession)" >&2; \
      exit 1; \
    fi

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:26.12.1-bookworm-slim AS runtime

# Runtime binaries claws shells out to:
#   git          — clone/worktree operations
#   tmux         — interactive session backing store
#   openssh-client — runner SSH
#   gh           — GitHub CLI (token injected via env per-call)
#   jq, sqlite3, curl, ca-certificates — ancillary scripting
#   ripgrep, fd-find — preinstalled so pi uses them from PATH instead of
#                  downloading its own unverified copies per run
#   cups-client  — lp/lpstat/cancel for the `print` session capability;
#                  CUPS_SERVER is only set in sessions granted it
#   python3, make, g++ — node-gyp, so a plain `npm ci` in an agent pod builds
#                  native modules (better-sqlite3 and node-pty compile when the repo approves them in package.json allowScripts)
#   procps       — ps, so agents can inspect their own processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux zsh openssh-client ca-certificates curl jq sqlite3 tini util-linux ripgrep fd-find cups-client \
      python3 make g++ procps \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Compile native modules against the base image's bundled headers and never
# fetch them from nodejs.org (see the builder stage, #2862) — for agents'
# `npm ci` as much as for the global installs below. The
# `npm_package_config_node_gyp_` prefix is used because npm 11.20 warns on
# unknown `npm_config_*` keys such as `nodedir`, and node-gyp reads this prefix
# too. Nix (wired up after the store copy) verifies substitutes against
# Debian's CA bundle.
ENV npm_package_config_node_gyp_nodedir=/usr/local \
    NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# kubectl is deliberately absent: sessions and agents hold no cluster
# credentials, and Claws itself talks to the API server through src/k8s/api.ts.

# AI CLIs. Claude is required; Codex / OpenCode / Pi are soft-failed because
# upstream package renames happen frequently and we don't want releases
# to break for an optional fallback provider. release.yml passes
# CLAUDE_CODE_VERSION and CODEX_VERSION with the versions it resolved from
# npm; `latest` is only the default for local/manual builds.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && (npm install -g @openai/codex@${CODEX_VERSION} || echo "codex install failed — soft fail") \
 && (npm install -g opencode-ai@latest || echo "opencode install failed — soft fail") \
 && (npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest || echo "pi install failed — soft fail")

# Stopgap until a node:26 tag bundles an npm whose own undici is >= 6.29.1 (CVE-2026-109869) and
# brace-expansion >= 5.0.11 (npm 12.2.0 still ships 6.28.0 / 5.0.9, both with
# fixable HIGH CVEs the fleet-infra image scan blocks on). Swap the bundled
# copies for fixed releases; node-gyp needs undici ^6.25.0 and minimatch
# brace-expansion ^5.0.5, so both stay in range. The assertions fail the build
# if a future npm reshuffles its tree.
RUN npmdir=/usr/local/lib/node_modules/npm/node_modules \
 && tmp="$(mktemp -d)" \
 && cd "$tmp" \
 && npm pack --silent undici@6.29.1 brace-expansion@5.0.12 \
 && for pkg in undici brace-expansion; do \
      rm -rf "$npmdir/$pkg" && mkdir "$npmdir/$pkg" \
      && tar -xzf "$tmp/$pkg"-*.tgz -C "$npmdir/$pkg" --strip-components=1; \
    done \
 && cd / && rm -rf "$tmp" \
 && test "$(node -p "require('$npmdir/undici/package.json').version")" = 6.29.1 \
 && test "$(node -p "require('$npmdir/brace-expansion/package.json').version")" = 5.0.12 \
 && npm --version >/dev/null \
 && npm config list >/dev/null

# Stopgap until Pi ships with undici >= 8.12.2 (CVE-2026-109869): it pins
# undici 8.10.2 exactly. No-op when the soft-fail Pi install is missing.
RUN pidir=/usr/local/lib/node_modules/@earendil-works/pi-coding-agent \
 && if [ -d "$pidir" ]; then \
      tmp="$(mktemp -d)" && cd "$tmp" \
      && npm pack --silent undici@8.12.2 \
      && find "$pidir" -type d -name undici -path '*/node_modules/undici' | while read -r d; do \
           v="$(node -p "require('$d/package.json').version")"; \
           case "$v" in 8.*) \
             if [ "$(printf '%s\n8.12.2\n' "$v" | sort -V | head -n1)" != 8.12.2 ]; then \
               rm -rf "$d" && mkdir "$d" \
               && tar -xzf "$tmp"/undici-*.tgz -C "$d" --strip-components=1; \
             fi;; \
           esac; \
         done \
      && cd / && rm -rf "$tmp"; \
    fi

RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && useradd -m -u 1000 -s /bin/bash claws

# Capabilities granted to a running session pod land in its mounted
# granted-env; every shell sources it so the vars need no manual step. The
# pod sets BASH_ENV for the normal non-interactive path; bash with a socket on
# stdin and SHLVL < 2 (the agent's own Bash tool and other node-spawned shells)
# skips BASH_ENV and runs /etc/bash.bashrc then ~/.bashrc, so the hook must
# precede Debian's interactive-only `return` at the top of that file. The other
# hooks cover login bash (profile.d) and every zsh (zshenv). The file is absent
# in the service container, so the hook is a no-op there.
RUN hook='[ -r /etc/claws-workload/granted-env ] && . /etc/claws-workload/granted-env' \
 && printf '%s\n' "$hook" > /etc/profile.d/claws-granted-env.sh \
 && mkdir -p /etc/zsh \
 && { printf '%s\n' "$hook"; cat /etc/bash.bashrc; } > /tmp/bb \
 && mv /tmp/bb /etc/bash.bashrc \
 && chmod 0644 /etc/bash.bashrc \
 && printf '\n%s\n' "$hook" >> /etc/zsh/zshenv \
 && head -n1 /etc/bash.bashrc | grep -q claws-workload/granted-env \
 && mkdir -p /etc/claws-workload \
 && chmod 0755 /etc/claws-workload \
 && smoke='const r=require("child_process").spawnSync("/bin/bash",["-c","echo ${CLAWS_SMOKE_GRANT-unset}"],{stdio:["pipe","pipe","inherit"]});process.stdout.write(r.stdout)' \
 && echo 'export CLAWS_SMOKE_GRANT=yes' > /etc/claws-workload/granted-env \
 && chmod 0644 /etc/claws-workload/granted-env \
 && test "$(runuser -u claws -- env -u SHLVL HOME=/home/claws node -e "$smoke")" = yes \
 && : > /etc/claws-workload/granted-env \
 && test "$(runuser -u claws -- env -u SHLVL HOME=/home/claws node -e "$smoke")" = unset \
 && rm -rf /etc/claws-workload

COPY --from=session-shell-defaults /claws-skel /etc/skel
COPY --from=session-shell-defaults --chown=claws:claws /nix/store /nix/store
COPY --from=session-shell-defaults --chown=claws:claws /nix/var/nix/registration /nix/var/nix/registration
COPY --from=session-shell-defaults /claws-shell-profile /opt/claws/shell-profile
# Keep the Node runtime and Debian tools first. Session startup prepends its
# authentication shim to this inherited PATH.
ENV PATH="${PATH}:/opt/claws/shell-profile/bin"

# Single-user Nix: claws owns /nix, so `nix` uses the local store directly
# instead of falling back to a user-namespace chroot store, which the pod's
# security context forbids ("setting up a private mount namespace: Operation
# not permitted"). The copied store is registered from the session shell's
# closureInfo registration.
RUN set -e; \
    mkdir -p /nix/var/nix/db /nix/var/nix/profiles /nix/var/nix/gcroots \
      /nix/var/nix/temproots /nix/var/nix/userpool /nix/var/log/nix /etc/nix; \
    chown claws:claws /nix /nix/store /nix/var; \
    chown -R claws:claws /nix/var/nix /nix/var/log; \
    printf '%s\n' \
      'experimental-features = nix-command flakes' \
      'sandbox = false' \
      'build-users-group =' \
      'warn-dirty = false' \
      > /etc/nix/nix.conf; \
    nix_home="$(mktemp -d)"; chown claws:claws "$nix_home"; \
    runuser -u claws -- env HOME="$nix_home" nix-store --load-db < /nix/var/nix/registration; \
    rm -rf "$nix_home"

# Shipped before the smoke tests below, which read /etc/ssh/ssh_known_hosts.
COPY --chmod=0644 deploy/ssh-known-hosts /etc/ssh/ssh_known_hosts

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
    test -z "$(runuser -u claws -- env HOME="$smoke_home" git config --global --get-all credential.helper)"; \
    runuser -u claws -- env HOME="$smoke_home" sh -c 'for file in "$HOME/.zshrc" "$HOME/.ssh/config"; do printf "\n# edit smoke test\n" >> "$file"; done'; \
    test "$(ssh-keygen -lf /etc/ssh/ssh_known_hosts | grep -c ED25519)" = 3; \
    ssh_cfg="$(runuser -u claws -- env HOME="$smoke_home" ssh -G ryzen)"; \
    echo "$ssh_cfg" | grep -qE '^globalknownhostsfile /etc/ssh/ssh_known_hosts( |$)'; \
    echo "$ssh_cfg" | grep -qx 'stricthostkeychecking ask'; \
    for pair in thinkcentre:192.168.0.251; do \
      host_cfg="$(runuser -u claws -- env HOME="$smoke_home" ssh -G "${pair%%:*}")"; \
      echo "$host_cfg" | grep -qx "hostname ${pair##*:}"; \
      echo "$host_cfg" | grep -qx 'user brendan'; \
      echo "$host_cfg" | grep -qE '^globalknownhostsfile /etc/ssh/ssh_known_hosts( |$)'; \
      ssh-keygen -F "${pair##*:}" -f /etc/ssh/ssh_known_hosts >/dev/null; \
    done; \
    test ! -e /home/brendan; \
    rm -rf "$smoke_home"

WORKDIR /opt/claws
COPY --from=builder --chown=claws:claws /src/dist ./dist
COPY --from=builder --chown=claws:claws /src/node_modules ./node_modules
COPY --from=builder --chown=claws:claws /src/package.json ./package.json
COPY --chown=claws:claws .skills /opt/claws/deploy/skills
COPY --chown=claws:claws --chmod=0755 deploy/install-skills.sh deploy/container-entrypoint.sh /opt/claws/deploy/

# Fail the build if any shipped copy is below its fixed version; fleet-infra's
# image-scan blocks on CVE-2026-109869 (undici 6.x < 6.29.1, 8.x < 8.12.2) and
# CVE-2026-111181 (body-parser < 2.4.0).
RUN node -e '\
const fs=require("fs"),path=require("path");\
const lt=(a,b)=>{const x=a.split(".").map(Number),y=b.split(".").map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]<y[i];}return false;};\
const bad=[];\
const walk=d=>{let es;try{es=fs.readdirSync(d,{withFileTypes:true});}catch{return;}\
for(const e of es){const p=path.join(d,e.name);if(e.isSymbolicLink())continue;\
if(e.isDirectory())walk(p);else if(e.name==="package.json"){try{const j=JSON.parse(fs.readFileSync(p,"utf8"));\
const v=String(j.version||"");\
if((j.name==="undici"&&((v.startsWith("6.")&&lt(v,"6.29.1"))||(v.startsWith("8.")&&lt(v,"8.12.2"))))||(j.name==="body-parser"&&lt(v,"2.4.0")))bad.push(p+" "+v);}catch{}}}};\
walk("/usr/local/lib/node_modules");walk("/opt/claws/node_modules");\
if(bad.length){console.error("vulnerable packages:\n"+bad.join("\n"));process.exit(1);}'

# Ensure the data dir is writable by the non-root user even before a
# PVC mounts over it (k8s fsGroup handles the mount case).
RUN mkdir -p /home/claws/.claws \
 && chown -R claws:claws /home/claws

USER claws
ENV HOME=/home/claws \
    PORT=3000 \
    CLAWS_BIND_HOST=0.0.0.0 \
    # No NODE_ENV here: agent and session shells inherit the image env, and
    # NODE_ENV=production makes a plain `npm ci` skip dev dependencies.
    # deploy/container-entrypoint.sh sets it for the service alone.
    CLAWS_RUNTIME=container \
    # The npm prefix above is root-owned, so uid 1000 can never write to it and
    # the CLI's self-updater always fails (#3088). The image pins the CLI
    # version instead, and claude-code-release.yml's daily check publishes new versions.
    # Session pods and headless agent runs inherit this from the image.
    # Codex has no equivalent env var, so Claws instead disables its startup
    # update check in every config.toml it writes
    # (check_for_update_on_startup = false, #3312).
    DISABLE_AUTOUPDATER=1

# Toolchain smoke tests as the agent user: the store registration loaded
# (path-info on a session-shell path), nix-command and flakes are enabled,
# node-gyp's toolchain and ps are present, and a fresh login shell has no NODE_ENV.
RUN set -e; \
    nix_home="$(mktemp -d)"; \
    HOME="$nix_home" nix path-info "$(readlink -f /opt/claws/shell-profile/bin/zsh)" >/dev/null; \
    test "$(HOME="$nix_home" nix eval --expr '1 + 1')" = 2; \
    command -v python3 g++ make ps >/dev/null; \
    if HOME="$nix_home" npm config list 2>&1 | grep -q 'Unknown env config'; then echo "npm warns about an unknown env config" >&2; exit 1; fi; \
    HOME="$nix_home" bash -lc 'test -z "${NODE_ENV:-}"'; \
    rm -rf "$nix_home"

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["/opt/claws/deploy/container-entrypoint.sh"]

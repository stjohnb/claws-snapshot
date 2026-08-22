# ── Build stage ───────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS builder

WORKDIR /src

# Install build-time deps for better-sqlite3 / node-pty native modules
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# esbuild's postinstall writes its native binary then immediately execs it to
# verify; under BuildKit/overlayfs this intermittently fails with ETXTBSY
# ("text file busy"). Retry to absorb that race (#1745).
RUN for i in 1 2 3; do \
      echo "npm ci attempt $i"; \
      npm ci && exit 0; \
      echo "attempt $i failed, cleaning node_modules and retrying after 3s..."; \
      rm -rf node_modules; \
      sleep 3; \
    done; \
    echo "npm ci failed after 3 attempts" >&2; \
    exit 1

COPY tsconfig.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

# Runtime binaries claws shells out to:
#   git          — clone/worktree operations
#   tmux         — interactive session backing store
#   openssh-client — runner SSH + datasette export
#   gh           — GitHub CLI (token injected via env per-call)
#   jq, sqlite3, curl, ca-certificates — ancillary scripting
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git tmux openssh-client ca-certificates curl jq sqlite3 tini \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# AI CLIs. Claude is required; Codex / OpenCode are soft-failed because
# upstream package renames happen frequently and we don't want releases
# to break for an optional fallback provider.
RUN npm install -g @anthropic-ai/claude-code@latest \
 && (npm install -g @openai/codex@latest || echo "codex install failed — soft fail") \
 && (npm install -g opencode-ai@latest || echo "opencode install failed — soft fail")

RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && useradd -m -u 1000 -s /bin/bash claws

WORKDIR /opt/claws
COPY --from=builder --chown=claws:claws /src/dist ./dist
COPY --from=builder --chown=claws:claws /src/node_modules ./node_modules
COPY --from=builder --chown=claws:claws /src/package.json ./package.json

# Ensure the data dir is writable by the non-root user even before a
# PVC mounts over it (k8s fsGroup handles the mount case).
RUN mkdir -p /home/claws/.claws \
 && chown -R claws:claws /home/claws

USER claws
ENV HOME=/home/claws \
    PORT=3000 \
    CLAWS_BIND_HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/claws/dist/main.js"]

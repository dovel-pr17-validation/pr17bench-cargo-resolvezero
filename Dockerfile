FROM node:24-bookworm-slim

# App entrypoint override (fly.toml build-args; defaults to the edge)
ARG ENTRY=apps/edge/src/index.ts
ENV APP_ENTRY=$ENTRY

WORKDIR /app

# Pin pnpm (Node images may/may not ship corepack).
RUN npm install -g pnpm@10.2.0

# Workspace-aware install: root manifests + dependency manifests for caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/edge/package.json apps/edge/package.json
RUN pnpm install --frozen-lockfile --prod

# Application sources
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/edge apps/edge

ENV NODE_ENV=production
# Writable home for the unprivileged runtime user.
ENV HOME=/tmp
EXPOSE 8080 9091 53 53/udp

# Start as root only to bind 53; the app calls dropPrivileges() immediately
# after binding and runs as UID/GID 1000. tsx executes TypeScript directly.
CMD ["sh", "-c", "exec ./node_modules/.bin/tsx $APP_ENTRY"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

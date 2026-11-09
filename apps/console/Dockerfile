# Build context is the repo root: `fly deploy --config fly.console.toml`.
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.2.0 --activate
WORKDIR /repo

# Workspace manifests first so dependency installs cache independently of source.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/console/package.json apps/console/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/edge/package.json apps/edge/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @resolvezero/console build

FROM node:24-slim
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /repo
RUN useradd --system --uid 10001 --no-create-home resolvezero
COPY --from=build /repo /repo
USER resolvezero
EXPOSE 8080
CMD ["node", "apps/console/server.mjs"]

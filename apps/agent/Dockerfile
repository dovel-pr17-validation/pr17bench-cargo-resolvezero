FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json ./
RUN bun install
COPY src ./src
RUN bun build --compile --target=bun-linux-x64 src/index.ts --outfile /resolvezero-agent

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home resolvezero-agent || true
COPY --from=build /resolvezero-agent /usr/local/bin/resolvezero-agent
EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/usr/local/bin/resolvezero-agent"]

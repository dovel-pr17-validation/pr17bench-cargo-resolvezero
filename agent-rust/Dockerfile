FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home resolvezero-agent || true
COPY --from=build /app/target/release/resolvezero-agent /usr/local/bin/resolvezero-agent
EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/usr/local/bin/resolvezero-agent"]

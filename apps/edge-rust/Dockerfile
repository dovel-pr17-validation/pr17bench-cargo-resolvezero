FROM rust:1.99-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/resolvezero-edge /usr/local/bin/resolvezero-edge
ENV HOME=/tmp
EXPOSE 8080 9091 53 53/udp
USER root
CMD ["/usr/local/bin/resolvezero-edge"]

//! ResolveZero edge — Rust data plane (work in progress).
//!
//! Ported from `apps/edge/src/*.ts`. The artifact/fingerprint semantics and
//! response shapes are intentionally identical so a Rust machine can be run
//! side by side with the Node edge behind the same database.

pub mod artifact;
pub mod cache;
pub mod config;
pub mod db;
pub mod dns;
pub mod fingerprint;
pub mod limits;
pub mod lists;
pub mod metrics;
pub mod netguard;
pub mod parse;
pub mod server;
pub mod services;
pub mod stats;
pub mod store;
pub mod upstream;

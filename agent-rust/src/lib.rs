#![forbid(unsafe_code)]
//! Local DNS-to-DoH forwarder for ResolveZero.
//!
//! This is a 1:1 rewrite of `apps/agent` (TypeScript) so the agent can ship as
//! a single static binary without a JavaScript runtime. The modules mirror the
//! original files: `config` ← `config.ts`, `dns` ← `dns.ts`, `doh` ← `doh.ts`,
//! `server` ← `server.ts`.

pub mod config;
pub mod dns;
pub mod doh;
pub mod log;
pub mod server;

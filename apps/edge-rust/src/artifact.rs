//! Content-addressed rule artifact.
//!
//! Layout (all integers little-endian):
//!   0   4  magic "RZA1"
//!   4   1  format version (1)
//!   5   1  flags (bit0 allow table, bit1 delta, bit2 bundle)
//!   6   2  header bytes (24)
//!   8   4  allow count
//!  12   4  block count
//!  16   4  total rules
//!  20   4  reserved (0)
//!  24  …  allow u64 × allowCount, sorted ascending
//!   …  …  block u64 × blockCount, sorted ascending
//!
//! The file bytes are deterministic for the same rule set, so the artifact id
//! is `sha256(file)`. The fingerprint function is xxhash64 seed 0, identical in
//! the TypeScript and Rust runtimes.

use std::time::{Duration, SystemTime};

use std::fmt::Write as _;

use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::fingerprint::FingerprintTable;

pub const MAGIC: [u8; 4] = *b"RZA1";
pub const VERSION: u8 = 1;
pub const HEADER_BYTES: u16 = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub allow: Vec<u64>,
    pub block: Vec<u64>,
}

impl Artifact {
    pub fn from_table(table: FingerprintTable) -> Self {
        let (allow, block) = table.into_parts();
        Self { allow, block }
    }

    pub fn rules(&self) -> usize {
        self.allow.len() + self.block.len()
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES as usize + self.rules() * 8);
        out.extend_from_slice(&MAGIC);
        out.push(VERSION);
        out.push(u8::from(!self.allow.is_empty()));
        out.extend_from_slice(&HEADER_BYTES.to_le_bytes());
        out.extend_from_slice(&(self.allow.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.block.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.rules() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for value in &self.allow {
            out.extend_from_slice(&value.to_le_bytes());
        }
        for value in &self.block {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER_BYTES as usize {
            return Err("artifact shorter than header".into());
        }
        if bytes[0..4] != MAGIC {
            return Err("bad artifact magic".into());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported artifact version {}", bytes[4]));
        }
        let header_bytes = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
        if header_bytes != HEADER_BYTES as usize {
            return Err(format!("unexpected header size {header_bytes}"));
        }
        let allow_count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        let block_count = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
        let header_total =
            u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) as usize;
        let total = allow_count
            .checked_add(block_count)
            .ok_or("artifact count overflow")?;
        if header_total != total {
            return Err("artifact total does not match counts".into());
        }
        let expected = header_bytes
            .checked_add(total.checked_mul(8).ok_or("artifact size overflow")?)
            .ok_or("artifact size overflow")?;
        if bytes.len() != expected {
            return Err("artifact length does not match header".into());
        }
        let mut allow = Vec::with_capacity(allow_count);
        let mut block = Vec::with_capacity(block_count);
        let mut offset = header_bytes;
        for index in 0..total {
            let value = u64::from_le_bytes(
                bytes[offset..offset + 8]
                    .try_into()
                    .map_err(|_| "truncated artifact")?,
            );
            offset += 8;
            if index < allow_count {
                allow.push(value);
            } else {
                block.push(value);
            }
        }
        Ok(Self { allow, block })
    }

    pub fn into_table(self) -> FingerprintTable {
        FingerprintTable::from_sorted(self.allow, self.block)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Sidecar metadata stored next to the binary (and in `rule_artifacts`).
#[derive(Clone, Debug)]
pub struct ArtifactMeta {
    pub id: String,
    pub source: String,
    pub allow: usize,
    pub block: usize,
    pub bytes: usize,
    pub created_at: String,
}

impl ArtifactMeta {
    pub fn for_artifact(id: String, source: String, artifact: &Artifact, bytes: usize) -> Self {
        Self {
            id,
            source,
            allow: artifact.allow.len(),
            block: artifact.block.len(),
            bytes,
            created_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_default(),
        }
    }

    pub fn to_json(&self) -> String {
        format!(
            "{{\"id\":\"{}\",\"source\":\"{}\",\"allow\":{},\"block\":{},\"rules\":{},\"bytes\":{},\"compiler\":\"rz-compile/0.1\",\"hash\":\"xxhash64/seed0\",\"createdAt\":\"{}\"}}",
            json_escape(&self.id),
            json_escape(&self.source),
            self.allow,
            self.block,
            self.allow + self.block,
            self.bytes,
            json_escape(&self.created_at)
        )
    }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

// ---- S3 GET (SigV4) ----

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub prefix: String,
    client: reqwest::Client,
}

impl S3Config {
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("S3_ENDPOINT").ok()?;
        let allow_http = std::env::var("ALLOW_HTTP_S3").as_deref() == Ok("1");
        let local =
            endpoint.starts_with("http://localhost") || endpoint.starts_with("http://127.0.0.1");
        if !endpoint.starts_with("https://") && !(allow_http || local) {
            // Fail closed: SigV4 credentials must never travel in cleartext.
            return None;
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .ok()?;
        Some(Self {
            endpoint,
            region: std::env::var("S3_REGION").unwrap_or_else(|_| "auto".into()),
            bucket: std::env::var("S3_BUCKET").ok()?,
            access_key_id: std::env::var("S3_ACCESS_KEY_ID").ok()?,
            secret_access_key: std::env::var("S3_SECRET_ACCESS_KEY").ok()?,
            prefix: std::env::var("ARTIFACT_PREFIX").unwrap_or_else(|_| "artifacts".into()),
            client,
        })
    }

    pub fn key(&self, hash: &str) -> String {
        format!("{}/{}.bin", self.prefix.trim_matches('/'), hash)
    }

    pub async fn get(&self, hash: &str) -> Result<Vec<u8>, String> {
        self.get_key(&self.key(hash)).await
    }

    pub async fn get_key(&self, key: &str) -> Result<Vec<u8>, String> {
        const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
        let response = self.request("GET", key, "", b"", None).await?;
        if !response.status().is_success() {
            return Err(format!("artifact GET {} -> {}", key, response.status()));
        }
        if let Some(length) = response.content_length() {
            if length as usize > MAX_ARTIFACT_BYTES {
                return Err("artifact exceeds 64 MiB".into());
            }
        }
        let mut stream = response.bytes_stream();
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| err.to_string())?;
            if out.len() + chunk.len() > MAX_ARTIFACT_BYTES {
                return Err("artifact exceeds 64 MiB".into());
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }

    /// One page of S3 ListObjectsV2. Returns keys and the continuation token.
    pub async fn list(
        &self,
        prefix: &str,
        continuation: Option<&str>,
    ) -> Result<(Vec<String>, Option<String>), String> {
        let mut params: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1000".into()),
            ("prefix".into(), prefix.to_string()),
        ];
        if let Some(token) = continuation {
            params.push(("continuation-token".into(), token.to_string()));
        }
        params.sort_by(|a, b| a.0.cmp(&b.0));
        let query = params
            .iter()
            .map(|(key, value)| {
                format!("{}={}", encode_uri_segment(key), encode_uri_segment(value))
            })
            .collect::<Vec<_>>()
            .join("&");
        let response = self.request("GET", "", &query, b"", None).await?;
        if !response.status().is_success() {
            return Err(format!("S3 LIST -> {}", response.status()));
        }
        let body = response.bytes().await.map_err(|err| err.to_string())?;
        let text = String::from_utf8_lossy(&body);
        Ok((
            xml_values(&text, "Key"),
            xml_value(&text, "NextContinuationToken"),
        ))
    }

    /// PUT an object (used by the raw-log archive). Returns an error on any
    /// non-2xx response so the caller can queue a retry.
    pub async fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String> {
        let response = self
            .request("PUT", key, "", body, Some(content_type))
            .await?;
        if !response.status().is_success() {
            return Err(format!("S3 PUT {key} -> {}", response.status()));
        }
        Ok(())
    }

    async fn request(
        &self,
        method: &str,
        key: &str,
        query: &str,
        body: &[u8],
        content_type: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let endpoint = self.endpoint.trim_end_matches('/');
        let host = endpoint
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(endpoint)
            .trim_end_matches('/');
        let canonical_uri = if key.is_empty() {
            format!("/{}", encode_uri_segment(&self.bucket))
        } else {
            format!(
                "/{}/{}",
                encode_uri_segment(&self.bucket),
                key.split('/')
                    .map(encode_uri_segment)
                    .collect::<Vec<_>>()
                    .join("/")
            )
        };
        let url = if query.is_empty() {
            format!("{endpoint}{canonical_uri}")
        } else {
            format!("{endpoint}{canonical_uri}?{query}")
        };

        let now = OffsetDateTime::now_utc();
        let amz_date = now
            .format(&format_description!(
                "[year][month][day]T[hour][minute][second]Z"
            ))
            .map_err(|err| err.to_string())?;
        let date = &amz_date[..8];
        let payload_hash = sha256_hex(body);

        let canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let signing_key = signing_key(&self.secret_access_key, date, &self.region);
        let signature = hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.access_key_id, scope, signed_headers, signature
        );

        let mut request = self
            .client
            .request(method.parse().map_err(|_| "invalid method")?, &url)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("authorization", authorization);
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        request
            .body(body.to_vec())
            .send()
            .await
            .map_err(|err| err.to_string())
    }
}

fn xml_value(text: &str, tag: &str) -> Option<String> {
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = text[start..].find(&format!("</{tag}>"))? + start;
    Some(xml_unescape(&text[start..end]))
}

fn xml_values(text: &str, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(xml_unescape(&after[..end]));
        rest = &after[end + close.len()..];
    }
    out
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn encode_uri_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac accepts any key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Unused in the loaded path; kept for sidecar age checks in scripts.
pub fn age_seconds(modified: SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::FingerprintTable;
    use std::collections::HashSet;

    fn artifact() -> Artifact {
        let blocks: HashSet<String> = ["ads.example", "tracker.example"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let allows: HashSet<String> = ["good.example"].into_iter().map(str::to_string).collect();
        Artifact::from_table(FingerprintTable::build(&blocks, &allows))
    }

    #[test]
    fn roundtrips_and_is_deterministic() {
        let artifact = artifact();
        let bytes = artifact.encode();
        let decoded = Artifact::decode(&bytes).unwrap();
        assert_eq!(decoded, artifact);
        assert_eq!(artifact.encode(), bytes);
        assert_eq!(bytes.len(), HEADER_BYTES as usize + artifact.rules() * 8);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(Artifact::decode(b"nope").is_err());
        let mut bytes = artifact().encode();
        bytes[0] = b'X';
        assert!(Artifact::decode(&bytes).is_err());
        let mut bytes = artifact().encode();
        bytes[4] = 9;
        assert!(Artifact::decode(&bytes).is_err());
    }

    #[test]
    fn id_is_sha256_of_the_file() {
        let bytes = artifact().encode();
        assert_eq!(sha256_hex(&bytes).len(), 64);
        assert_eq!(sha256_hex(&bytes), sha256_hex(&bytes));
    }

    #[test]
    fn sidecar_is_valid_json_shape() {
        let artifact = artifact();
        let bytes = artifact.encode();
        let meta = ArtifactMeta::for_artifact(
            sha256_hex(&bytes),
            "https://example/list".into(),
            &artifact,
            bytes.len(),
        );
        let json = meta.to_json();
        assert!(json.contains("\"rules\":3"));
        assert!(json.contains("xxhash64/seed0"));
    }
}

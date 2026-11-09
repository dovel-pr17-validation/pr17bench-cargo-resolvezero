//! rz-compile — turn a blocklist URL or file into a content-addressed artifact.
//!
//!   rz-compile --url https://… --out artifacts
//!   rz-compile --file ./list.txt --format hosts --out artifacts
//!
//! Prints the sidecar JSON to stdout. The file is `<sha256>.bin`; the sidecar
//! is `<sha256>.json`.

use std::path::PathBuf;

use resolvezero_edge::artifact::{sha256_hex, Artifact, ArtifactMeta};
use resolvezero_edge::fingerprint::FingerprintTable;
use resolvezero_edge::netguard::SafeFetcher;
use resolvezero_edge::parse::{parse_list, ListFormat};

struct Args {
    url: Option<String>,
    file: Option<PathBuf>,
    format: ListFormat,
    out: PathBuf,
    source: Option<String>,
    max_bytes: usize,
    json_only: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut url = None;
    let mut file = None;
    let mut format = ListFormat::Auto;
    let mut out = PathBuf::from("artifacts");
    let mut source = None;
    let mut max_bytes = 30 * 1024 * 1024;
    let mut json_only = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => url = Some(args.next().ok_or("--url needs a value")?),
            "--file" => file = Some(PathBuf::from(args.next().ok_or("--file needs a value")?)),
            "--format" => {
                let value = args.next().ok_or("--format needs a value")?;
                format = ListFormat::parse(&value);
            }
            "--out" => out = PathBuf::from(args.next().ok_or("--out needs a value")?),
            "--source" => source = Some(args.next().ok_or("--source needs a value")?),
            "--max-bytes" => {
                max_bytes = args
                    .next()
                    .ok_or("--max-bytes needs a value")?
                    .parse()
                    .map_err(|_| "invalid --max-bytes")?;
            }
            "--json-only" => json_only = true,
            "--help" | "-h" => {
                println!("rz-compile --url <u> | --file <path> [--format auto|abp|hosts|domains] [--out dir] [--source label]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    if url.is_none() == file.is_none() {
        return Err("provide exactly one of --url or --file".into());
    }
    Ok(Args {
        url,
        file,
        format,
        out,
        source,
        max_bytes,
        json_only,
    })
}

async fn fetch_text(url: &str, max_bytes: usize) -> Result<String, String> {
    let fetcher = SafeFetcher::new(max_bytes, true);
    let bytes = fetcher.get(url).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("rz-compile: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    let (text, source) = match (&args.url, &args.file) {
        (Some(url), None) => (
            fetch_text(url, args.max_bytes).await?,
            args.source.clone().unwrap_or_else(|| url.clone()),
        ),
        (None, Some(path)) => (
            std::fs::read_to_string(path).map_err(|err| err.to_string())?,
            args.source
                .clone()
                .unwrap_or_else(|| path.display().to_string()),
        ),
        _ => unreachable!(),
    };

    let parsed = parse_list(&text, args.format);
    let table = FingerprintTable::build(&parsed.blocks, &parsed.allows);
    let artifact = Artifact::from_table(table);
    let bytes = artifact.encode();
    let id = sha256_hex(&bytes);
    let meta = ArtifactMeta::for_artifact(id.clone(), source, &artifact, bytes.len());

    if !args.json_only {
        std::fs::create_dir_all(&args.out).map_err(|err| err.to_string())?;
        std::fs::write(args.out.join(format!("{id}.bin")), &bytes)
            .map_err(|err| err.to_string())?;
        std::fs::write(args.out.join(format!("{id}.json")), meta.to_json())
            .map_err(|err| err.to_string())?;
    }
    println!("{}", meta.to_json());
    Ok(())
}

import { loadConfig } from "./config";
import { startAgent } from "./server";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`configuration error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("required: PROFILE_ID, DOH_TOKEN; optional: DOH_URL, BIND_HOST, DNS_PORT, DEVICE_MAP");
    process.exit(1);
  }

  let agent;
  try {
    agent = await startAgent(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: "error", msg: "failed to bind DNS listener", err: message }));
    if (message.includes("EACCES") || message.includes("permission")) {
      console.error("Port 53 requires root or CAP_NET_BIND_SERVICE.");
    }
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
    void agent.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();

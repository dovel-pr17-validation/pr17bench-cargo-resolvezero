import type { Packet, PacketOpt } from "dns-packet";

/**
 * EDNS Client Subnet is response-varying: two clients with different ECS
 * values must not share a cache entry or an in-flight upstream request.
 * Returns a stable key component even when ECS is absent.
 */
export function ecsKey(packet: Packet): string {
  const opt = (packet.additionals ?? []).find((r) => r.type === "OPT") as
    | { options?: PacketOpt[] }
    | undefined;
  const ecs = opt?.options?.find((option) => option.type === "CLIENT_SUBNET") as
    | { family?: number; sourcePrefixLength?: number; ip?: string }
    | undefined;
  if (!ecs) return "ecs:none";
  return `ecs:${ecs.family ?? "?"}/${ecs.sourcePrefixLength ?? "?"}/${(ecs.ip ?? "").toLowerCase()}`;
}

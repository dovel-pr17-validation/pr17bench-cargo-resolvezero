/**
 * Blocked-service catalog.
 *
 * Static data, shared by the console (toggles) and the edge (which expands a
 * profile's selected services into synthetic block rules at snapshot time).
 * Domains are matched suffix-style, so "tiktok.com" also covers
 * "www.tiktok.com" and "api2.tiktok.com" — list the registrable domain, not
 * every host.
 */
export interface BlockedService {
  id: string;
  label: string;
  domains: string[];
}

export const BLOCKED_SERVICES: BlockedService[] = [
  {
    id: "tiktok",
    label: "TikTok",
    domains: ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "muscdn.com", "byteoversea.com", "ibytedtos.com"],
  },
  {
    id: "instagram",
    label: "Instagram",
    domains: ["instagram.com", "cdninstagram.com", "ig.me"],
  },
  {
    id: "facebook",
    label: "Facebook",
    domains: ["facebook.com", "fbcdn.net", "fb.com", "messenger.com"],
  },
  {
    id: "youtube",
    label: "YouTube",
    domains: ["youtube.com", "youtu.be", "ytimg.com", "googlevideo.com", "youtube-nocookie.com"],
  },
  {
    id: "snapchat",
    label: "Snapchat",
    domains: ["snapchat.com", "sc-cdn.net", "snapkit.com"],
  },
  {
    id: "x",
    label: "X / Twitter",
    domains: ["x.com", "twitter.com", "twimg.com", "t.co"],
  },
  {
    id: "reddit",
    label: "Reddit",
    domains: ["reddit.com", "redd.it", "redditmedia.com", "redditstatic.com"],
  },
  {
    id: "discord",
    label: "Discord",
    domains: ["discord.com", "discordapp.com", "discordapp.net", "discord.gg"],
  },
  {
    id: "roblox",
    label: "Roblox",
    domains: ["roblox.com", "rbxcdn.com", "robloxlabs.com"],
  },
  {
    id: "twitch",
    label: "Twitch",
    domains: ["twitch.tv", "ttvnw.net", "jtvnw.net"],
  },
  {
    id: "netflix",
    label: "Netflix",
    domains: ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com"],
  },
  {
    id: "spotify",
    label: "Spotify",
    domains: ["spotify.com", "scdn.co", "spotifycdn.com"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    domains: ["whatsapp.com", "whatsapp.net"],
  },
  {
    id: "telegram",
    label: "Telegram",
    domains: ["telegram.org", "t.me", "telegram.me"],
  },
  {
    id: "pinterest",
    label: "Pinterest",
    domains: ["pinterest.com", "pinimg.com"],
  },
];

const BY_ID = new Map(BLOCKED_SERVICES.map((service) => [service.id, service]));

export function blockedService(id: string): BlockedService | undefined {
  return BY_ID.get(id);
}

/** Flattens selected service ids into their domain list, skipping unknown ids. */
export function blockedServiceDomains(ids: string[]): string[] {
  const domains = new Set<string>();
  for (const id of ids) {
    for (const domain of BY_ID.get(id)?.domains ?? []) domains.add(domain);
  }
  return [...domains];
}

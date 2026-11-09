//! Blocked-service catalog (port of `packages/db/src/services.ts`).
//! Services expand into synthetic suffix rules; explicit profile rules win.

use std::collections::HashMap;

const SERVICES: &[(&str, &[&str])] = &[
    (
        "tiktok",
        &[
            "tiktok.com",
            "tiktokcdn.com",
            "tiktokv.com",
            "muscdn.com",
            "byteoversea.com",
            "ibytedtos.com",
        ],
    ),
    ("instagram", &["instagram.com", "cdninstagram.com", "ig.me"]),
    (
        "facebook",
        &["facebook.com", "fbcdn.net", "fb.com", "messenger.com"],
    ),
    (
        "youtube",
        &[
            "youtube.com",
            "youtu.be",
            "ytimg.com",
            "googlevideo.com",
            "youtube-nocookie.com",
        ],
    ),
    ("snapchat", &["snapchat.com", "sc-cdn.net", "snapkit.com"]),
    ("x", &["x.com", "twitter.com", "twimg.com", "t.co"]),
    (
        "reddit",
        &[
            "reddit.com",
            "redd.it",
            "redditmedia.com",
            "redditstatic.com",
        ],
    ),
    (
        "discord",
        &[
            "discord.com",
            "discordapp.com",
            "discordapp.net",
            "discord.gg",
        ],
    ),
    ("roblox", &["roblox.com", "rbxcdn.com", "robloxlabs.com"]),
    ("twitch", &["twitch.tv", "ttvnw.net", "jtvnw.net"]),
    (
        "netflix",
        &["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com"],
    ),
    ("spotify", &["spotify.com", "scdn.co", "spotifycdn.com"]),
    ("whatsapp", &["whatsapp.com", "whatsapp.net"]),
    ("telegram", &["telegram.org", "t.me", "telegram.me"]),
    ("pinterest", &["pinterest.com", "pinimg.com"]),
];

pub fn blocked_service_domains(ids: &[String]) -> Vec<&'static str> {
    let by_id: HashMap<&str, &[&str]> = SERVICES.iter().copied().collect();
    let mut out = Vec::new();
    for id in ids {
        if let Some(domains) = by_id.get(id.as_str()) {
            out.extend(domains.iter().copied());
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_known_services_only() {
        let domains = blocked_service_domains(&["youtube".into(), "nope".into()]);
        assert!(domains.contains(&"youtube.com"));
        assert!(domains.contains(&"googlevideo.com"));
        assert!(!domains.contains(&"nope.com"));
    }
}

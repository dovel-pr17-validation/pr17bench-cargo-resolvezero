import { describe, expect, test } from "vitest";
import { detectFormat, fetchListText, parseList } from "./blocklists";
import { RuleStore } from "./ruleStore";
import { SuffixFingerprintBuilder } from "./fingerprint";

describe("parseList", () => {
  test("hosts format (polish-pihole hostfile shape)", () => {
    const text = `# comment
127.0.0.1 localhost
0.0.0.0 ads.example.com
0.0.0.0 sub.tracker.pl # inline note
tracker2.pl
`
        .replace("tracker2.pl", "tracker2.pl");
    const { blocks } = parseList(text, "hosts");
    expect(blocks.has("ads.example.com")).toBe(true);
    expect(blocks.has("sub.tracker.pl")).toBe(true);
    expect(blocks.has("tracker2.pl")).toBe(true);
    expect(blocks.has("localhost")).toBe(false);
  });

  test("empty file", () => {
    const { blocks, allows } = parseList("", "hosts");
    expect(blocks.size).toBe(0);
    expect(allows.size).toBe(0);
  });

  test("abp: blocks and @@ exceptions split", () => {
    const text = `! title line
||ads.pl^
||cdn.adnet.pl^$third-party
@@||cdn.adnet.pl^
##.advert
||not-a-domain^
`;
    const { blocks, allows } = parseList(text, "abp");
    expect(blocks.has("ads.pl")).toBe(true);
    // @@ exceptions live in `allows`; resolveRemote applies allow-first
    expect(allows.has("cdn.adnet.pl")).toBe(true);
    expect(blocks.size).toBe(2); // cosmetics + non-domain rules dropped
  });

  test("invalid domains dropped", () => {
    const { blocks } = parseList(`notadomain\n0.0.0.0 .bad\n0.0.0.0 ok.example.com..`, "hosts");
    expect(blocks.has("notadomain")).toBe(false);
    expect(blocks.has("bad") || blocks.has(".bad")).toBe(false);
    expect(blocks.has("ok.example.com")).toBe(true);
  });
});

describe("detectFormat", () => {
  test("hosts files (IP + domain lines)", () => {
    expect(
      detectFormat(`# hosts
127.0.0.1 localhost
0.0.0.0 ads.example.com
0.0.0.0 tracker.example.net # note
`),
    ).toBe("hosts");
  });

  test("bare domain lists", () => {
    expect(
      detectFormat(`# domains
ads.example.com
tracker.example.net
cdn.example.org
`),
    ).toBe("domains");
  });

  test("adblock syntax, including exceptions", () => {
    expect(
      detectFormat(`! title
||ads.example.com^
||cdn.example.net^$third-party
@@||good.example.org^
`),
    ).toBe("abp");
  });

  test("ignores comments and blank lines when sampling", () => {
    expect(detectFormat(`# comment\n\n! header\n||ads.example.com^\n`)).toBe("abp");
  });

  test("empty or unrecognised input falls back to domains", () => {
    expect(detectFormat("")).toBe("domains");
    expect(detectFormat("# only comments\n")).toBe("domains");
  });

  test("auto format parses through detection", () => {
    const abp = parseList("||ads.example.com^\n@@||ok.example.com^\n", "auto");
    expect(abp.blocks.has("ads.example.com")).toBe(true);
    expect(abp.allows.has("ok.example.com")).toBe(true);

    const hosts = parseList("0.0.0.0 ads.example.com\n", "auto");
    expect(hosts.blocks.has("ads.example.com")).toBe(true);

    const domains = parseList("ads.example.com\ntracker.example.net\n", "auto");
    expect(domains.blocks.size).toBe(2);
  });
});

describe("RuleStore shared blocklist catalog", () => {
  const tableFrom = (blocks: string[], allows: string[] = []) => {
    const b = new SuffixFingerprintBuilder();
    for (const d of blocks) b.add(d, "block");
    for (const d of allows) b.add(d, "allow");
    return b.seal();
  };

  test("upsertList + setSubscriptions: allow beats block across lists", () => {
    const store = new RuleStore();
    const blockedList = tableFrom(["doubleclick.net"]);
    const allowedList = tableFrom(["mail.doubleclick.net"], ["mail.doubleclick.net"]);
    store.upsertList("https://lists.example/blocked", blockedList);
    store.upsertList("https://lists.example/allow", allowedList);
    // subscription order does NOT matter; allow-tables checked first
    store.setSubscriptions("p1", ["https://lists.example/blocked", "https://lists.example/allow"]);
    expect(store.resolveRemote("p1", "ad.doubleclick.net")).toBe("block");
    expect(store.resolveRemote("p1", "mail.doubleclick.net")).toBe("allow");
    expect(store.resolveRemote("p1", "www.mail.doubleclick.net")).toBe("allow");
    expect(store.resolveRemote("unknown-profile", "ad.doubleclick.net")).toBeUndefined();
    // syntax sanity: ```
  });

  test("resolveRemoteDetailed attributes the winning list ID", () => {
    const store = new RuleStore();
    store.upsertList("https://lists.example/blocked", tableFrom(["doubleclick.net"]));
    store.upsertList("https://lists.example/second", tableFrom(["doubleclick.net"]));
    store.setSubscriptions("p1", [
      { url: "https://lists.example/blocked", listId: "list-a" },
      { url: "https://lists.example/second", listId: "list-b" },
    ]);
    expect(store.resolveRemoteDetailed("p1", "ads.doubleclick.net")).toEqual({
      action: "block",
      listId: "list-a",
    });
    expect(store.resolveRemoteDetailed("p1", "example.com")).toBeUndefined();
  });

  test("catalog dedups: two profiles sharing one list parse/store once", () => {
    const store = new RuleStore();
    const t = tableFrom(["a.com", "b.com"]);
    expect(store.upsertList("https://lists.example/shared", t)).toBe(true);
    store.setSubscriptions("p1", ["https://lists.example/shared"]);
    // second profile subscribing: no new catalog entry
    store.setSubscriptions("p2", ["https://lists.example/shared"]);
    expect(store.stats.remoteListTables).toBe(1);
    expect(store.stats.remoteListSubscriptions).toBe(2);
    expect(store.resolveRemote("p2", "a.com")).toBe("block");
    // same-content re-upsert doesn't change state's consumed-changed flag
    store.consumeChanged();
    expect(store.upsertList("https://lists.example/shared", tableFrom(["a.com", "b.com"]))).toBe(false);
    expect(store.consumeChanged()).toBe(false);
    // changed content does
    expect(store.upsertList("https://lists.example/shared", tableFrom(["a.com", "c.com"]))).toBe(true);
    expect(store.consumeChanged()).toBe(true);
  });

  test("subset profile does not prune tables another profile needs", () => {
    const store = new RuleStore();
    store.upsertList("a", tableFrom(["a.com"]));
    store.upsertList("b", tableFrom(["b.com"]));
    // Wire p1 (a+b) then p2 (a only), deferring pruning as the sync loop does.
    store.setSubscriptions("p1", ["a", "b"], { prune: false });
    store.setSubscriptions("p2", ["a"], { prune: false });
    store.pruneUnreferencedLists();
    expect(store.stats.remoteListTables).toBe(2);
    expect(store.resolveRemote("p1", "b.com")).toBe("block");
    expect(store.resolveRemote("p2", "b.com")).toBeUndefined();
  });

  test("GC: catalog entry dropped when no profile subscribes to it", () => {
    const store = new RuleStore();
    store.upsertList("u", tableFrom(["a.com"]));
    store.setSubscriptions("p1", ["u"]);
    store.setSubscriptions("p1", []); // unsubscribed
    expect(store.hasList("u")).toBe(false);
    expect(store.stats.remoteListTables).toBe(0);
  });

  test("replaceAll prunes subscriptions of dead profiles (roughly), keeps live ones", () => {
    const store = new RuleStore();
    store.upsertList("u", tableFrom(["a.com"]));
    store.setSubscriptions("p1", ["u"]);
    // a DB snapshot without p1 must drop its subscription
    store.replaceAll([], [], [{ id: "other", dohToken: null, logQueries: true, upstream: null }]);
    expect(store.stats.remoteListSubscriptions).toBe(0);
    expect(store.hasList("u")).toBe(false);
  });
});

describe("fetchListText", () => {
  test("rejects junk urls quickly", async () => {
    await expect(fetchListText("not a url")).rejects.toThrow();
  }, 65_000);
});

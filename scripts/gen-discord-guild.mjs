/**
 * Generate a large synthetic Discord guild as DiscordChatExporter JSON: several
 * channel files, 1,000 human accounts and 100 bots, plus one merged file and an
 * account roster.
 *
 * Orbit's JSON import reads a single `channel` per file and replaces the loaded
 * dataset on every import, so each channel is written as its own file and the
 * merged file exists only to load the whole guild in one import.
 *
 * Accounts carry designed traits (see the ARCHETYPES table) and are written to
 * accounts.csv, so a profiler run can be compared against the design.
 *
 * Deterministic: a fixed seed reproduces the same roster, messages, and ids.
 *
 *   node scripts/gen-discord-guild.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../sample/nimbus-community");

const SEED = 0x5eed2024;
const GUILD = { id: "1216000000000000001", name: "Nimbus Community", iconUrl: null };
const HUMAN_COUNT = 1000;
const BOT_COUNT = 100;
const DISCORD_EPOCH = 1420070400000n;
const DAY_MS = 86_400_000;
const START_MS = Date.parse("2024-03-01T00:00:00Z");
const SPAN_DAYS = 14;

/**
 * Channel plan. `terse` channels skip the extra clause fragments so short
 * channel-appropriate lines (commands, log notes) stay short.
 */
const CHANNELS = [
  { slug: "general", name: "general", category: "Community", humans: 700, bots: 30, messages: 1800, topic: "Anything and everything. Be decent." },
  { slug: "support", name: "support", category: "Engineering", humans: 350, bots: 20, messages: 900, topic: "Stuck? Ask here with the exact error." },
  { slug: "dev", name: "dev", category: "Engineering", humans: 250, bots: 15, messages: 800, topic: "Architecture, reviews, and postmortems." },
  { slug: "off-topic", name: "off-topic", category: "Community", humans: 300, bots: 10, messages: 700, topic: "Not work. Still be decent." },
  { slug: "introductions", name: "introductions", category: "Community", humans: 380, bots: 5, messages: 400, topic: "Say hello and what you work on." },
  { slug: "bot-spam", name: "bot-spam", category: "Automation", humans: 20, bots: 60, messages: 500, topic: "Command the bots here.", terse: true },
  { slug: "mod-log", name: "mod-log", category: "Automation", humans: 5, bots: 25, messages: 250, topic: "Automated moderation record.", terse: true },
  { slug: "announcements", name: "announcements", category: "Info", humans: 5, bots: 5, messages: 60, topic: "Read-only. Releases and outages." },
];

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** Mulberry32: small, fast, seeded PRNG so a run is reproducible. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(SEED);
const pick = (list) => list[Math.floor(rng() * list.length)];
const chance = (p) => rng() < p;
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const ADJECTIVES = ["swift", "quiet", "amber", "brisk", "calm", "clever", "dusk", "ember", "faint", "frost", "glad", "hollow", "idle", "jade", "keen", "lucid", "mellow", "nimble", "opal", "plain", "rapid", "rust", "slate", "tidy", "umber", "vivid", "wry", "zesty", "arctic", "bold"];
const NOUNS = ["otter", "lantern", "harbor", "kestrel", "meadow", "cinder", "pebble", "thistle", "willow", "badger", "ferry", "gable", "ivory", "juniper", "kettle", "lattice", "marlin", "nettle", "orchid", "pine", "quarry", "reed", "summit", "tundra", "vellum", "wren", "yarrow", "zephyr", "anvil", "cobalt"];
const FIRST = ["mara", "priya", "devon", "sam", "nova", "kestrel", "jules", "ravi", "lena", "theo", "ines", "omar", "talia", "bruno", "yuki", "hana", "diego", "freya", "malik", "noor", "elin", "cass", "pavel", "rhea", "tomas", "zara"];
const LAST = ["k", "r", "w", "ito", "raman", "kessler", "whitfield", "okafor", "novak", "silva", "haddad", "lindqvist", "moreau", "tanaka", "petrov", "berg", "costa"];

/** Human archetypes drive both the generated text and the ground-truth segment column. */
const ARCHETYPES = [
  { id: "technical", share: 0.20, traits: { verbosity: 0.7, formality: 0.5, technical: 0.9, emoji: 0.1, hostility: 0.1, disclosure: 0.2, help: 0.3 } },
  { id: "casual", share: 0.30, traits: { verbosity: 0.35, formality: 0.15, technical: 0.2, emoji: 0.8, hostility: 0.1, disclosure: 0.4, help: 0.2 } },
  { id: "support-seeker", share: 0.15, traits: { verbosity: 0.5, formality: 0.35, technical: 0.35, emoji: 0.2, hostility: 0.15, disclosure: 0.5, help: 0.95 } },
  { id: "contrarian", share: 0.10, traits: { verbosity: 0.6, formality: 0.3, technical: 0.5, emoji: 0.1, hostility: 0.75, disclosure: 0.2, help: 0.1 } },
  { id: "burnout", share: 0.08, traits: { verbosity: 0.55, formality: 0.25, technical: 0.4, emoji: 0.15, hostility: 0.2, disclosure: 0.9, help: 0.4 } },
  { id: "lurker", share: 0.17, traits: { verbosity: 0.2, formality: 0.3, technical: 0.3, emoji: 0.3, hostility: 0.1, disclosure: 0.2, help: 0.3 } },
];

function archetypeFor(roll) {
  let acc = 0;
  for (const a of ARCHETYPES) {
    acc += a.share;
    if (roll <= acc) return a;
  }
  return ARCHETYPES[ARCHETYPES.length - 1];
}

const titleCase = (word) => word.replace(/\b\w/g, (c) => c.toUpperCase());

/** Build 1,000 unique human accounts with designed traits and a display name. */
function buildHumans() {
  const used = new Set();
  const humans = [];
  for (let i = 0; i < HUMAN_COUNT; i++) {
    let username;
    let nickname;
    do {
      const style = rng();
      const adjective = pick(ADJECTIVES);
      const noun = pick(NOUNS);
      if (style < 0.45) {
        username = `${adjective}${noun}`;
        nickname = `${titleCase(adjective)} ${titleCase(noun)}`;
      } else if (style < 0.75) {
        username = `${adjective}_${noun}`;
        nickname = `${titleCase(adjective)} ${titleCase(noun)}`;
      } else {
        const first = pick(FIRST);
        const last = pick(LAST);
        username = `${first}${last}`;
        nickname = `${titleCase(first)} ${last.length === 1 ? last.toUpperCase() : titleCase(last)}`;
      }
      if (chance(0.25)) username += String(between(2, 99));
    } while (used.has(username));
    used.add(username);

    const archetype = archetypeFor(rng());
    const jitter = (v) => Math.min(1, Math.max(0, v + (rng() - 0.5) * 0.3));
    const traits = Object.fromEntries(Object.entries(archetype.traits).map(([k, v]) => [k, Number(jitter(v).toFixed(2))]));

    humans.push({
      id: String(200000000000000000n + BigInt(i)),
      username,
      nickname,
      isBot: false,
      archetype: archetype.id,
      traits,
      activity: archetype.id === "lurker" ? between(1, 3) : between(2, 14) + (traits.verbosity > 0.6 ? between(0, 8) : 0),
    });
  }
  return humans;
}

/** Bot template families. Utility bots reuse one template, which is what makes them detectable. */
const BOT_FAMILIES = [
  { id: "deploy", templates: ["**Deploy finished** — `{svc}@{ver}` → production. {n} checks passed, 0 failed. Commit `{sha}` by {user}.", "**Deploy started** — `{svc}@{ver}` → staging. {n} checks queued. Commit `{sha}` by {user}.", "**Deploy rolled back** — `{svc}@{ver}`. {n} checks failed. Commit `{sha}` by {user}."] },
  { id: "welcome", templates: ["Welcome {user} to {guild}! Please read #rules and say hi in #introductions.", "{user} just joined. Say hello!", "Welcome aboard {user} — start with #introductions and #support."] },
  { id: "modlog", templates: ["**{action}** — {user} was {action} for `{reason}`. Case #{n}.", "**{action}** — {user} `{reason}`. Case #{n}.", "**{action}** — {user}, `{reason}`, case #{n}."] },
  { id: "alert", templates: ["🔔 {svc} is {state}: {metric} at {value} (threshold {thr}).", "🔔 {svc} recovered. {metric} back to {value}.", "🔔 {svc} {state} — {metric} {value}."] },
  { id: "faq", templates: ["If your build fails with `{err}`, run `{cmd}` and retry.", "That error usually means `{err}`. Try `{cmd}` first.", "`{err}` is almost always fixed by `{cmd}`."] },
  { id: "reminder", templates: ["Reminder: {event} starts in {n} minutes.", "Reminder: {event} is tomorrow at {time} UTC.", "{event} in {n} minutes."] },
  { id: "poll", templates: ["📊 Poll: {question} — react with {emoji}.", "📊 New poll in #general: {question}.", "📊 Should we {question}? React below."] },
  { id: "promo", templates: ["🚀 **FREE {thing}** → {url} (limited time, only {n} left!)", "🎉 Claim your free {thing} now → {url}", "**{thing} giveaway** — {n} spots left → {url}"] },
  { id: "digest", templates: ["Daily digest: {n} new posts, {m} open threads, top tag `{tag}`.", "Weekly digest: {n} posts across {m} channels, top tag `{tag}`.", "Digest: {n} posts, {m} threads, `{tag}` trending."] },
];

/** Which channels each bot family plausibly posts in; also fixes bot homes. */
const FAMILY_CHANNELS = {
  deploy: ["dev", "announcements", "bot-spam"],
  welcome: ["introductions", "general"],
  modlog: ["mod-log", "general"],
  alert: ["dev", "support", "bot-spam"],
  faq: ["support", "bot-spam"],
  reminder: ["bot-spam", "general", "off-topic"],
  poll: ["bot-spam", "general", "off-topic"],
  promo: ["bot-spam", "general", "off-topic"],
  digest: ["announcements", "general", "bot-spam"],
};

const BOT_NAMES = ["tinytools", "mimir", "pipeline-owl", "ci-runner", "deploybot", "modwatch", "sentinel", "keeper", "pulse", "relay", "beacon", "warden", "ledger", "quill", "harborwatch", "lumen", "orbit-sync", "grapevine", "tally", "abacus", "stripe-alerts", "github-hook", "sentry-sidekick", "statuspage", "uptime-fox", "pollmaster", "remindme", "linkfixer", "antiraid", "welcomer"];

/** Build 100 bots. Most names carry no `bot` suffix so name matching cannot find them. */
function buildBots() {
  const bots = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    const family = BOT_FAMILIES[i % BOT_FAMILIES.length];
    const base = BOT_NAMES[i % BOT_NAMES.length];
    const cycle = Math.floor(i / BOT_NAMES.length);
    let username = cycle === 0 ? base : `${base}-${cycle + 1}`;
    if (chance(0.25)) username = username.replace(/-(alerts|hook|watch|owl|runner|page|fox|sync)$/, "");
    bots.push({
      id: String(100000000000000000n + BigInt(i)),
      username,
      nickname: titleCase(username.replace(/-/g, " ")),
      isBot: true,
      archetype: `bot:${family.id}`,
      traits: {},
      family: family.id,
      activity: between(3, 10),
    });
  }
  return bots;
}

const humans = buildHumans();
const bots = buildBots();
const accounts = [...humans, ...bots];

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const EMOJI = ["🙂", "😅", "🔥", "🎉", "👀", "🤝", "☕", "🧠", "🚀", "😭", "💡", "✅", "🫠", "🙏", "😬"];

const POOLS = {
  general: [
    "anyone else seeing the dashboard load slowly today",
    "we hit 40k members this week which is wild",
    "the new search is so much faster than the old one",
    "reminder that the community call moved to Thursday",
    "i finally understand how the retry budget works",
    "does the mobile app feel laggy for anyone else",
    "someone should write up the onboarding flow, it's a maze",
    "the docs rewrite landed and it's a big improvement",
    "i've been using the CLI for a month and only now found the config flag",
    "this server is genuinely the best place i've found for these questions",
    "has anyone actually read the new pricing page",
    "i keep forgetting which channel is for what",
    "the search index rebuilt overnight and everything is instant now",
    "we should do another community call, the last one was useful",
    "is there a mirror for the status page, the main one is down for me",
    "shoutout to whoever fixed the dark mode contrast",
    "the changelog this week is longer than the release itself",
    "i'd pay for a proper desktop client at this point",
    "does anyone know if the mobile beta is still open",
    "the onboarding email sequence finally makes sense",
    "just spent an hour on a bug that was a stale cache",
    "the new member role colours are a nice touch",
    "anyone else get the survey email today",
    "i think the docs search is better than the site search",
    "we should pin the setup guide, it gets asked weekly",
    "the uptime graph has been flat green all month, nice",
    "who maintains the community bot list these days",
    "the release notes are getting genuinely good",
  ],
  support: [
    "i'm getting a 502 from the gateway after the last deploy",
    "the webhook fires twice for the same event, is that expected",
    "my token works locally but returns 401 in CI",
    "how do i rotate credentials without downtime",
    "the retry logic gives up after three attempts, can i raise that",
    "logs show `invalid_grant` but the secret is freshly rotated",
    "does the SDK handle rate limits automatically or should i back off myself",
    "the migration hung for twenty minutes and then succeeded",
    "i can't reproduce it locally, only in staging",
    "is there a way to dry-run the bulk import before committing",
    "the queue drains slower every night around midnight",
    "pagination returns the same cursor twice near the end",
    "the connection pool never releases under load",
    "config reload does not pick up changes without a restart",
    "the paginated endpoint silently drops the last page",
    "getting intermittent timeouts on the bulk endpoint",
    "the CLI ignores the profile flag when run through make",
    "webhook signatures fail only behind our proxy",
    "the SDK retries 500s but not 429s",
    "attachments over 8MB fail with a generic error",
    "the sandbox key works but production rejects it",
    "why does the first request after idle take four seconds",
    "the export job finishes but the file is truncated",
    "our staging deploy now takes eleven minutes",
    "the health endpoint returns ok while the db is unreachable",
    "upgrading the SDK changed the error types",
    "the scheduled job runs twice when the worker restarts",
    "secrets with special characters get mangled",
  ],
  dev: [
    "the projection rebuild took nine minutes on the full history",
    "i'd rather keep the event log than migrate to audit tables",
    "that abstraction has three callers, it isn't earning its keep",
    "we should gate this behind a flag and roll it out gradually",
    "the postmortem action items are still open from last month",
    "i benchmarked the parser and most of the time is in the regex",
    "the interface is fine, the implementation is the problem",
    "let's write the failing test first and then decide",
    "the schema change needs a backfill plan before we ship it",
    "reviewing this PR i can't tell what the invariant is supposed to be",
    "the retry policy belongs in the client, not in every call site",
    "we're paying for a queue we don't need yet",
    "the migration can be online if we dual-write for a week",
    "i'd split this into two services before adding another flag",
    "the type checker caught the bug the tests missed",
    "coverage went up but the tests got worse",
    "this deserves a design doc before anyone writes code",
    "the cache invalidation path is the risky part, not the cache",
    "we should measure before optimising the hot loop",
    "the deploy script has grown into a program",
    "that dependency is unmaintained and we only use one function",
    "the error handling swallows the cause and logs a generic message",
    "i'd rather have one boring module than three clever ones",
    "the test suite takes twelve minutes, nobody runs it locally",
    "can we agree on a naming convention for the events",
    "the rollback is not actually tested",
    "this is the third abstraction over the same HTTP client",
    "the config has eleven ways to express the same thing",
  ],
  "off-topic": [
    "what mechanical keyboard is everyone using these days",
    "i made bread for the first time and it was fine, that's it, that's the post",
    "my cat walked across the keyboard and closed four tabs",
    "anyone have a good podcast for long walks",
    "the weather here finally turned and i'm unreasonably happy about it",
    "i've been playing the same game for six years and i'm not stopping",
    "weekend plans: absolutely nothing and i'm thrilled",
    "recommend me a book that isn't about software",
    "i finally fixed the squeaky door and i feel unstoppable",
    "my houseplant survived the winter, small victories",
    "the coffee place near me started roasting their own beans",
    "i ran for the first time in a year and my legs are furious",
    "anyone else keep a paper notebook for work",
    "i spent sunday building a shelf and it is only slightly crooked",
    "the new season of that show is better than the last one",
    "what's everyone cooking this week",
    "i bought a bike and immediately remembered hills exist",
    "my desk setup is finally cable-managed, for now",
    "the local library has a tool lending section, wild",
    "i've started walking without headphones and it's great",
    "anyone have a recommendation for a decent cheap monitor arm",
    "i repotted everything and now the flat looks like a greenhouse",
    "board game night was a success, we only argued twice",
    "the farmers market had strawberries in march somehow",
  ],
  introductions: [
    "hi all, i'm a backend engineer working mostly in Go and Postgres",
    "hello! joining because the docs kept pointing me here",
    "hey everyone, i do data platform work and i'm new to this stack",
    "hi, i'm a student learning distributed systems and this server has been great",
    "hello from a small team that just adopted the SDK",
    "hi all, i write frontend but i'm trying to learn infra",
    "hey, i've been lurking for a month and figured i should say hi",
    "hello! i run a tiny infra team and we're evaluating this for billing",
    "hi, i'm a support engineer moving into platform work",
    "hello, i maintain an open source client for this API",
    "hey all, i'm here to learn how people handle idempotency",
    "hi, i've been doing SRE for six years and just changed jobs",
    "hello! i teach a course and want to point students somewhere useful",
    "hi everyone, i'm a solo dev building a small SaaS",
    "hey, i came for the webhook docs and stayed for the community",
    "hello, i work on payments and care a lot about correctness",
    "hi, i'm new to the ecosystem but not to queuing systems",
    "hey all, i write Rust and i'm curious how the SDK handles backpressure",
    "hello, i'm a data engineer who inherited a pipeline",
    "hi, i do developer relations and want to help with docs",
    "hey, i'm between jobs and using the time to learn properly",
    "hello, i run a community of my own and want to compare notes",
    "hi, i mostly lurk but the support threads here are excellent",
    "hey, joining from a team that just hit our first outage",
  ],
  "bot-spam": [
    "/status",
    "/ping",
    "/poll create ship on friday or monday",
    "/remind me in 20 minutes",
    "!weather",
    "/digest weekly",
    "/uptime",
    "can someone add a bot that posts release notes here",
    "the poll bot lost its reaction again",
    "!help",
    "/subscribe releases",
    "is the reminder bot down for anyone else",
    "/antiraid status",
  ],
  "mod-log": [
    "reviewing the overnight queue",
    "the raid filter caught a wave of new accounts",
    "second spam wave in an hour",
    "confirmed the scam link, domain is two days old",
    "handing the queue over, nothing urgent",
  ],
  announcements: [
    "release notes for this week are up",
    "scheduled maintenance window on Saturday",
    "the incident review is published",
    "new status page is live",
  ],
};

const TECHNICAL_DETAILS = [
  "i checked the logs and the upstream line says connection refused",
  "the trace shows the pool pointing at the old task set",
  "i think it's a registration race during the drain",
  "the error only shows up under concurrent writes",
  "it reproduces with a clean checkout and no cache",
  "the timeout is 30s but the request finishes at 31",
  "the header is dropped somewhere in the proxy",
  "it's fine on the second attempt every time",
  "the index is missing on the foreign key",
  "the lock is held for the whole batch instead of per row",
];

const QUESTIONS = [
  "can anyone point me at the right doc",
  "what am i missing here",
  "has anyone hit this before",
  "any idea what causes this",
  "is that expected behaviour",
  "should i file an issue for this",
];

const QUALIFIERS = [
  "to be clear i'm not blaming anyone",
  "for what it's worth the workaround is straightforward",
  "which is fine, i just want to know the invariant",
  "no rush on this, it's not blocking me",
  "happy to write it up if that helps",
  "i might be holding it wrong",
];

const HOSTILE = [
  "this is the third time this quarter and nobody has fixed it",
  "i've raised this twice and it goes nowhere",
  "the process is the problem, not the people following it",
  "we keep shipping the same bug with a new name",
  "at this point the docs are actively misleading",
  "i'm tired of doing archaeology on our own infrastructure",
  "either someone owns this or it keeps happening",
  "this is why nothing ships on time here",
];

const DISCLOSURE = [
  "i've been running on very little sleep and it's catching up with me",
  "honestly this week has been a lot and i'm not sure how much longer i can keep the pace up",
  "some mornings the idea of opening the laptop makes me feel sick",
  "i took a day off and it helped more than i expected",
  "it's been a long stretch and i'm trying to be better about saying so",
  "i don't want to make it a whole thing, it's just been a lot",
];

/** Per-account memory so one account does not repeat the same opening line. */
const seenByAccount = new Map();

function chooseUnseen(accountId, pool) {
  const seen = seenByAccount.get(accountId) ?? new Set();
  const options = pool.filter((item) => !seen.has(item));
  const chosen = options.length > 0 ? pick(options) : pick(pool);
  seen.add(chosen);
  seenByAccount.set(accountId, seen);
  return chosen;
}

function humanMessage(account, channel) {
  const t = account.traits;
  const parts = [chooseUnseen(account.id, POOLS[channel.slug] ?? POOLS.general)];
  if (!channel.terse) {
    if (t.help > 0.6 && chance(0.8)) parts.push(pick(QUESTIONS));
    if (t.technical > 0.6 && chance(0.6)) parts.push(pick(TECHNICAL_DETAILS));
    if (t.hostility > 0.55 && chance(0.7)) parts.push(pick(HOSTILE));
    if (t.disclosure > 0.6 && chance(0.6)) parts.push(pick(DISCLOSURE));
    if (t.verbosity > 0.6 && chance(0.7)) parts.push(pick(QUALIFIERS));
  }

  let text = parts.join(". ").replace(/\.\./g, ".");
  text = t.formality < 0.35 ? text.charAt(0).toLowerCase() + text.slice(1) : text.charAt(0).toUpperCase() + text.slice(1);
  if (!channel.terse && t.emoji > 0.5 && chance(0.7)) text += ` ${pick(EMOJI)}`;
  if (!channel.terse && t.formality < 0.3 && chance(0.4)) text += pick([" lol", " tbh", " ngl", " fr"]);
  return text.trim();
}

function botMessage(account) {
  const family = BOT_FAMILIES.find((f) => f.id === account.family);
  const template = pick(family.templates);
  const [metric, value, thr] = pick([
    ["p99 latency", `${between(200, 870)}ms`, "900ms"],
    ["error rate", `${(between(5, 48) / 10).toFixed(1)}%`, "5.0%"],
    ["queue depth", `${between(400, 1900)} jobs`, "2000 jobs"],
  ]);
  const fill = {
    svc: pick(["api-gateway", "billing", "web", "worker", "ingest", "search"]),
    ver: `${between(1, 6)}.${between(0, 20)}.${between(0, 9)}`,
    n: String(between(8, 90)),
    m: String(between(3, 40)),
    sha: Math.floor(rng() * 0xfffffff).toString(16).padStart(7, "0"),
    user: pick(humans).username,
    guild: GUILD.name,
    action: pick(["Banned", "Timed out", "Warned", "Kicked"]),
    reason: pick(["spam", "raid participation", "scam link", "ban evasion"]),
    state: pick(["degraded", "recovering", "elevated"]),
    metric,
    value,
    thr,
    err: pick(["ELIFECYCLE", "ETIMEDOUT", "invalid_grant", "EADDRINUSE"]),
    cmd: pick(["npm ci", "docker compose up -d", "aws ecs update-service --force-new-deployment"]),
    event: pick(["the community call", "the release review", "office hours"]),
    time: `${between(9, 17)}:00`,
    question: pick(["ship on friday or wait for monday", "keep the event log", "raise the retry budget"]),
    emoji: pick(["👍", "🚀", "🐢", "1️⃣"]),
    thing: pick(["Nitro", "premium access", "a gift card"]),
    url: pick(["https://dlscord-nitro-gifts.ru/claim", "https://free-nitro-boost.com/get", "https://nimbus-discord-giveaway.top/claim"]),
    tag: pick(["help-wanted", "showcase", "bug"]),
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => fill[key] ?? `{${key}}`);
}

// ---------------------------------------------------------------------------
// Channel assignment
// ---------------------------------------------------------------------------

/** Give every account a home channel first so the union of channels covers the whole roster. */
function assignHomes() {
  const humanHomes = new Map();
  const botHomes = new Map();
  const humanOrder = shuffled(humans);
  let h = 0;
  for (const channel of CHANNELS) {
    for (let i = 0; i < channel.humans && h < humanOrder.length; i++) humanHomes.set(humanOrder[h++].id, channel.slug);
  }
  for (const bot of shuffled(bots)) {
    botHomes.set(bot.id, pick(FAMILY_CHANNELS[bot.family]));
  }
  return { humanHomes, botHomes };
}

const { humanHomes, botHomes } = assignHomes();

function humanParticipants(channel) {
  const chosen = new Map();
  for (const account of humans) {
    if (humanHomes.get(account.id) === channel.slug) chosen.set(account.id, account);
  }
  for (const account of shuffled(humans)) {
    if (chosen.size >= channel.humans) break;
    chosen.set(account.id, account);
  }
  return [...chosen.values()];
}

/** Bots only appear in channels their family plausibly posts in. */
function botParticipants(channel) {
  const allowed = bots.filter((bot) => FAMILY_CHANNELS[bot.family].includes(channel.slug));
  const homed = allowed.filter((bot) => botHomes.get(bot.id) === channel.slug);
  const chosen = new Map(homed.map((bot) => [bot.id, bot]));
  for (const bot of shuffled(allowed)) {
    if (chosen.size >= channel.bots) break;
    chosen.set(bot.id, bot);
  }
  return [...chosen.values()];
}

/** Weighted timestamp: community traffic clusters in the afternoon and evening UTC. */
function timestampFor() {
  const day = between(0, SPAN_DAYS - 1);
  const hour = chance(0.62) ? between(13, 23) : between(0, 12);
  return START_MS + day * DAY_MS + hour * 3_600_000 + between(0, 59) * 60_000 + between(0, 59) * 1000;
}

const messagesByChannel = new Map();
for (const channel of CHANNELS) {
  const roster = [...humanParticipants(channel), ...botParticipants(channel)];
  if (roster.length > channel.messages) throw new Error(`${channel.slug}: ${roster.length} participants exceed ${channel.messages} messages`);

  const entries = roster.map((account) => account);
  const budget = channel.messages - roster.length;
  const weight = (a) => (a.isBot ? a.activity : a.activity * (1 + a.traits.verbosity));
  const total = roster.reduce((sum, a) => sum + weight(a), 0);
  for (const account of roster) {
    const share = Math.round((weight(account) / total) * budget);
    for (let i = 0; i < share; i++) entries.push(account);
  }

  const messages = entries.map((account) => ({
    account,
    content: account.isBot ? botMessage(account) : humanMessage(account, channel),
    timestamp: timestampFor(),
  }));
  messages.sort((a, b) => a.timestamp - b.timestamp);
  messagesByChannel.set(channel.slug, messages);
}

// ---------------------------------------------------------------------------
// Emit files
// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const usedIds = new Set();
function snowflake(ms) {
  let id = (BigInt(ms) - DISCORD_EPOCH) << 22n;
  while (usedIds.has(id.toString())) id += 1n;
  usedIds.add(id.toString());
  return id.toString();
}

const iso = (ms) => new Date(ms).toISOString().replace("Z", "0000+00:00").replace(/\.(\d{3})0000/, ".$10000");

function renderChannel(channel, messages) {
  return {
    guild: GUILD,
    channel: {
      id: String(1216000000000001000n + BigInt(CHANNELS.indexOf(channel))),
      type: "GuildTextChat",
      categoryId: String(1216000000000002000n + BigInt(CHANNELS.indexOf(channel))),
      category: channel.category,
      name: channel.name,
      topic: channel.topic,
    },
    dateRange: { after: iso(messages[0].timestamp), before: iso(messages[messages.length - 1].timestamp) },
    messages: messages.map((m) => ({
      id: snowflake(m.timestamp),
      type: "Default",
      timestamp: iso(m.timestamp),
      content: m.content,
      author: {
        id: m.account.id,
        name: m.account.username,
        discriminator: "0000",
        nickname: m.account.nickname,
        isBot: m.account.isBot,
      },
      attachments: [],
      embeds: [],
    })),
    messageCount: messages.length,
  };
}

const channelFiles = [];
for (const channel of CHANNELS) {
  const messages = messagesByChannel.get(channel.slug);
  const file = `${String(CHANNELS.indexOf(channel) + 1).padStart(2, "0")}-${channel.slug}.json`;
  writeFileSync(resolve(outDir, file), `${JSON.stringify(renderChannel(channel, messages), null, 2)}\n`);
  channelFiles.push({
    file,
    name: channel.name,
    category: channel.category,
    messages: messages.length,
    accounts: new Set(messages.map((m) => m.account.id)).size,
    bots: new Set(messages.filter((m) => m.account.isBot).map((m) => m.account.id)).size,
  });
}

// One merged file so the whole guild loads in a single import.
const merged = [...CHANNELS.flatMap((channel) => messagesByChannel.get(channel.slug))].sort((a, b) => a.timestamp - b.timestamp);
const mergedChannel = { slug: "all-channels", name: "all-channels", category: "Merged", topic: "Every channel merged into one export, for a single import." };
writeFileSync(resolve(outDir, "all-channels.json"), `${JSON.stringify(renderChannel(mergedChannel, merged), null, 2)}\n`);

// Ground-truth roster: designed segment and traits, for comparing against profiler output.
const postedCounts = new Map();
for (const messages of messagesByChannel.values()) {
  for (const m of messages) postedCounts.set(m.account.id, (postedCounts.get(m.account.id) ?? 0) + 1);
}
const csv = [
  "id,username,nickname,is_bot,segment,designed_messages,home_channel,verbosity,formality,technical,emoji,hostility,disclosure,help_seeking",
  ...accounts.map((a) => {
    const t = a.traits;
    const home = (a.isBot ? botHomes : humanHomes).get(a.id) ?? "";
    const traits = a.isBot ? ["", "", "", "", "", "", ""] : [t.verbosity, t.formality, t.technical, t.emoji, t.hostility, t.disclosure, t.help].map((v) => v.toFixed(2));
    return [a.id, a.username, JSON.stringify(a.nickname), a.isBot, a.archetype, postedCounts.get(a.id) ?? 0, home, ...traits].join(",");
  }),
].join("\n");
writeFileSync(resolve(outDir, "accounts.csv"), `${csv}\n`);

const manifest = {
  guild: GUILD,
  seed: SEED,
  generatedFrom: "scripts/gen-discord-guild.mjs",
  totals: {
    accounts: accounts.length,
    humans: humans.length,
    bots: bots.length,
    messages: channelFiles.reduce((n, c) => n + c.messages, 0),
    channels: channelFiles.length,
  },
  channels: channelFiles,
  merged: { file: "all-channels.json", messages: merged.length, accounts: accounts.length },
};
writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`wrote ${channelFiles.length} channel files + all-channels.json to sample/nimbus-community/`);
console.log(`accounts: ${accounts.length} (${humans.length} humans, ${bots.length} bots) | messages: ${manifest.totals.messages}`);
for (const c of channelFiles) console.log(`  ${c.file.padEnd(22)} ${String(c.messages).padStart(5)} msgs  ${String(c.accounts).padStart(4)} accounts  ${String(c.bots).padStart(3)} bots`);

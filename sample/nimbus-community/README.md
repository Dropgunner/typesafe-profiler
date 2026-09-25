# Nimbus Community — large synthetic Discord guild

A generated Discord guild for exercising Orbit's Discord mode at scale: 8 channels, 1,000 human accounts, and 100 bot accounts across 5,299 messages. Every file is DiscordChatExporter JSON, the format Orbit reads for full fidelity.

Regenerate with:

```sh
node scripts/gen-discord-guild.mjs
```

The generator is seeded (`seed: 1592598564`), so rerunning it reproduces the same accounts, messages, and snowflake ids.

## Files

| File | Messages | Accounts | Bots |
| --- | --- | --- | --- |
| `01-general.json` | 1757 | 730 | 30 |
| `02-support.json` | 870 | 370 | 20 |
| `03-dev.json` | 798 | 265 | 15 |
| `04-off-topic.json` | 681 | 312 | 12 |
| `05-introductions.json` | 386 | 386 | 6 |
| `06-bot-spam.json` | 499 | 80 | 60 |
| `07-mod-log.json` | 250 | 16 | 11 |
| `08-announcements.json` | 58 | 12 | 7 |
| `all-channels.json` | 5299 | 1100 | 100 |

`all-channels.json` merges every channel into one export. `manifest.json` records the same table plus the seed, and `accounts.csv` is the design roster.

## Importing

Orbit's JSON import reads **one `channel` per file** and **replaces** the loaded dataset on every import (`orbit/src-tauri/src/commands/discord.rs`), and the file dialog selects a single file. There is no folder import and no merge.

- To browse one channel, import its numbered file.
- To load the whole guild at once, import `all-channels.json`. It is the only way to get all 1,100 accounts into one dataset, because the other files partition the roster.
- Importing a second file discards the first, so compare channels one at a time or use the merged file.

The guild name the plaintext and HTML import paths show comes from the file name; the JSON path uses the `guild.name` field, so all files report "Nimbus Community".

## What the dataset exercises

- **Bot detection.** All 100 bots carry `isBot: true`, but 96 of their account names contain no "bot" suffix, so detection cannot rely on the name. Each bot reuses one template family (deploy notices, welcome messages, moderation records, alerts, FAQ answers, reminders, polls, promo links, digests), which is the behavioural signal. Bot accounts post only in channels their family plausibly uses, so a family/channel mismatch is a generator bug.
- **Guardrails.** The `burnout` and `contrarian` archetypes in `accounts.csv` carry elevated self-disclosure and hostility respectively, so the profile and guard pipelines have designed positives to find.
- **Patterns.** Promo bots post three scam-link domains repeatedly, and utility bots repeat templates, giving the pattern matcher reusable strings to flag.
- **Profiling.** Each human has designed traits in `accounts.csv` (`verbosity`, `formality`, `technical`, `emoji`, `hostility`, `disclosure`, `help_seeking`) plus a segment label. Compare them against profiler output to check whether the pipeline recovers the design.

## Cost

Orbit scores one message per request, concurrency-limited (`orbit/src-tauri/src/profiler.rs`), and a full-guild profile run covers all 5,299 messages. Running profile, bot, and guard across every account is therefore thousands of TypeSafe API calls; start with one channel or a single user before running the merged file.

The channel user lists are rendered without virtualization (`orbit/src/components/DiscordPanel.tsx`), so a 1,100-account dataset builds 1,100 list nodes and will feel heavy.

## Roster

`accounts.csv` columns: `id`, `username`, `nickname`, `is_bot`, `segment`, `designed_messages`, `home_channel`, then the seven trait scores. Bots have empty trait columns and a `segment` of `bot:<family>`.

Human segments and their share of the 1,000: `technical` 20%, `casual` 30%, `support-seeker` 15%, `contrarian` 10%, `burnout` 8%, `lurker` 17%.

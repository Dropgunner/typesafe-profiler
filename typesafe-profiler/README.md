# typesafe-profiler

Turn a chat log into a structured read on the person behind it: **35 psychological dimensions**, scored message by message with the [TypeSafe](https://docs.typesafe.ai) decision model, then written out as a Markdown report for people and a JSON record for code.

> **Heuristic inference from individual messages — not a clinical or psychological assessment.** A score is a rough, descriptive signal about messages, never a diagnosis and never a decision about a person.

## Contents

- [The concept](#the-concept)
- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Try it in 60 seconds (no API key)](#try-it-in-60-seconds-no-api-key)
- [Score a real log](#score-a-real-log)
- [The four modes](#the-four-modes)
- [Feeding it your own logs](#feeding-it-your-own-logs)
- [The 35 dimensions](#the-35-dimensions)
- [Reading a score honestly](#reading-a-score-honestly)
- [Privacy](#privacy)
- [Command reference](#command-reference)
- [Debugging a wrong answer](#debugging-a-wrong-answer)
- [Bot detection](#bot-detection)
- [Pattern flagging and matching](#pattern-flagging-and-matching)
- [Guardrails routing](#guardrails-routing)
- [Integrations](#integrations)
- [Development](#development)
- [Caveats and responsible use](#caveats-and-responsible-use)
- [License](#license)

## The concept

Ask a language model "what is this person like?" and you get a fluent paragraph: hard to check, hard to compare between people, and impossible to aggregate. `typesafe-profiler` asks a narrower question and gets answers you can compute with.

| A chat model's answer | This tool's answer |
| --- | --- |
| One long opinion about the whole log | 35 fixed dimensions, each scored per message |
| Free-form prose | Typed answers: a number and a confidence, nothing to parse |
| A single judgment you must take on faith | Per-message scores aggregated into a mean, a standard deviation, and a sample size |
| Uncertainty implied by hedging | Uncertainty stored as numbers next to every score |

Three choices make the difference.

**1. A fixed rubric instead of an open prompt.** Every message is scored against the same 35 dimensions — clarity, need for cognition, openness, frustration, technical depth, and so on. Each dimension carries a written five-level rubric (level 0 to level 4), so "0.70 on Openness" means the same thing for every person you profile, and two profiles are directly comparable.

**2. A decision model instead of a chatbot.** [TypeSafe's Jev](https://docs.typesafe.ai/concepts/system-one) reads the message as `state` and answers typed questions. It can only return one of the answers you defined in advance — there is no free-form output to parse and no way for the model to invent a new category. Each answer also carries a confidence value, which measures how concentrated the answer distribution was. Confidence is not correctness: it says the model was not torn between its options, not that it was right.

**3. Aggregate, then validate.** One message is weak evidence about a person, so the tool scores many messages and reports the mean, the spread, and how many messages backed it. The finished profile is checked against a fixed schema — dimension ids, 0–1 ranges, polarity and basis enums, required evidence — and rejected if it fails. What you read is always a validated record.

The tool is honest about its own limits by construction: inverted-risk dimensions are flagged rather than silently scored high, thin evidence is marked as low sample, and every report ends with its caveats.

## What you get

Input — `sample/discord-export.txt`, five messages from one user:

```
[2024-01-03 10:02:11] alice#1234: I keep getting a 500 error when I try to sync my Stripe account. Logs say "invalid_grant" but the token is fresh.
[2024-01-03 10:04:05] alice#1234: Actually wait, I just realized I rotated the client secret last week and forgot to update the env file. Let me try that.
[2024-01-03 10:06:44] alice#1234: Yep, that fixed it. Updating the env var and restarting the worker cleared the error. Leaving this here in case someone else hits it.
...
```

Output — `discord-export.md`, excerpt:

| Category | Dimension | Score | n | Confidence | Polarity | Reading |
| --- | --- | --- | --- | --- | --- | --- |
| Communication | Clarity | 0.48 | 5 | 0.75 | desirable | moderate |
| Communication | Actionability | 0.65 | 5 | 0.78 | desirable | moderate |
| Cognitive | Need for cognition | 0.70 | 5 | 0.79 | desirable | high |
| Personality (Big Five) | Openness to experience | 0.72 | 5 | 0.68 | desirable | high |
| Domain Aptitude | Debugging orientation | 0.74 | 5 | 0.75 | desirable | high |
| Interaction / Behavioral | Engagement | 0.18 | 5 | 0.72 | desirable | low |

...plus a per-category detail table with each dimension's direction and spread, an **Evidence** section quoting the messages behind the scores, and a **Flagged** section:

```
## Flagged

- **Frustration / hostility** (Affective / Emotional): score 0.66, confidence 0.65 ⚠ elevated risk
- **Escalation readiness** (Interaction / Behavioral): score 0.62, confidence 0.73 ⚠ elevated risk
```

The same profile is written to `discord-export.json` as a structured record — every dimension with its score, confidence, sample size, stability flag, and evidence, plus the per-message scores for each dimension. That is the file to feed into your own code, dashboards, or clustering.

## How it works

```
chat log ──▶ parse ──▶ one message = one "state"
                            │
                            ▼
              TypeSafe / Jev: all 35 score questions
              (plus lightweight metadata: length, mentions,
               links, code, question/reply markers)
                            │
                            ▼
              score (0–1) + confidence, per dimension
                            │
                            ▼
        aggregate ──▶ validate against schema ──▶ <name>.md + <name>.json
```

One API call per message asks all 35 questions at once. Each answer's rubric position is normalized to 0–1 as `answer.score / 4`, then averaged across messages per dimension.

## Try it in 60 seconds (no API key)

```sh
npm install
npm run dev -- sample/ --dry-run
```

`--dry-run` runs the real parser, aggregation, validation, and renderers with deterministic fake scores, so you can see the whole pipeline and every output file without a TypeSafe account. Open `profile-output/discord-export.md`.

Requires Node.js 20 or newer.

## Score a real log

Get a key from [console.typesafe.ai](https://console.typesafe.ai/settings/keys), then pick whichever storage you prefer:

```sh
# A. .env file (recommended)
cp .env.example .env        # set TYPESAFE_API_KEY=sk-...
chmod 600 .env              # .env is git-ignored

# B. macOS Keychain (safest)
npm run dev -- --store-key  # prompts for the key, stores it, exits

# C. environment variable
export TYPESAFE_API_KEY=sk-...
```

The key is resolved from the first source found, in this order: `--api-key`, `TYPESAFE_API_KEY`, `.env` in the project root, then the macOS Keychain (service `typesafe-api-key`). The `--api-key` flag is the least safe option because the value is visible in the process list.

Then run it:

```sh
npm run dev -- sample/discord-export.txt          # one log
npm run dev -- sample/ --out profile-output       # a directory, recursively
npm run dev -- sample/ --limit 500 --concurrency 8
```

Or build once and use the compiled CLI:

```sh
npm run build
node dist/index.js sample/discord-export.txt --out profile-output
```

## The four modes

They are mutually exclusive; pick one per run.

| Mode | The question it answers | Output |
| --- | --- | --- |
| *(default)* | What is this person like, across 35 dimensions? | `<name>.md`, `<name>.json` |
| `--detect` | Does this transcript read as human or machine? | `<name>.detect.*` |
| `--guard` | Given this profile, should the system pass, review, block, or route to support? | `<name>.guard.*` |
| `--match` | Does this transcript contain the bot signatures I flagged earlier? | `<name>.patterns.*` |

The default profile, `--detect`, and `--guard` all call TypeSafe. `--match` is fully local and deterministic — it matches your saved patterns against the text and makes no API call, so it needs no key.

## Feeding it your own logs

Each input file should hold **one person's messages**, already filtered — one file, one profile. The parser scans the file and picks the dominant header style automatically:

| Format | Looks like |
| --- | --- |
| DiscordChatExporter plaintext | `[2024-01-01 12:00:00] Username#1234: text` |
| Discord copy-paste | `Username — Today at 12:34 PM` header, body on following lines |
| Markdown | `**Username**` or `**Username**:` then text |
| Simple | `Author: text` lines |
| Raw | no headers: one message per line, or per blank-line-separated block |

Point it at files, or at a directory — directories are walked recursively and every `.txt`, `.md`, `.markdown`, and `.log` file inside becomes an input. For richer exports (JSON or HTML from DiscordChatExporter), convert to plaintext first; JSON parsing is out of scope for the CLI.

## The 35 dimensions

| Category | Dimensions |
| --- | --- |
| Communication | Clarity, Technical accuracy, Actionability, Completeness, Tone/sentiment, Formality, Concreteness, Signal-to-noise ratio |
| Cognitive | Need for cognition, Analytic vs. intuitive, Tolerance for ambiguity, Abstraction ability, Confidence calibration, Cognitive rigidity |
| Personality (Big Five) | Openness, Conscientiousness, Extraversion, Agreeableness, Emotional stability |
| Motivation & Values | Risk tolerance, Promotion vs. prevention focus, Persistence/grit, Intrinsic motivation |
| Affective / Emotional | Empathy (expressed), Self-disclosure, Affect intensity, Frustration/hostility |
| Domain Aptitude | Technical depth, Mental-model correctness, Vocabulary sophistication, Debugging orientation |
| Interaction / Behavioral | Engagement, Help-seeking style, Self-correction, Escalation readiness |

Each dimension is a TypeSafe `score` question with a five-level anchored rubric, a **direction** ("high = clearer, more understandable"), and a **polarity**:

- `desirable` — a higher score is better.
- `inverted-risk` — a higher score is worse, and is flagged when elevated.
- `diagnostic` — neutral; used for classification, not judgment.

## Reading a score honestly

A profile row is `score`, `n`, `confidence`, and a `reading` label. The reading depends on polarity:

| Reading | `desirable` / `diagnostic` | `inverted-risk` |
| --- | --- | --- |
| high / elevated ⚠ | ≥ 0.70 | ≥ 0.60 |
| moderate | 0.45 – 0.69 | 0.40 – 0.59 |
| low | < 0.45 | < 0.40 |

A dimension is listed under **Flagged** when it is `inverted-risk` and ≥ 0.60, or when its evidence is thin: no scored messages, fewer than three scored messages (`low sample`), or mean confidence below 0.5 (`low confidence`).

Every dimension in the JSON is one fixed record instead of free text, so code that consumes it — identification, segmentation, dashboards — never has to guess what a field means:

```json
{
  "id": "clarity",
  "category": "Communication",
  "group": "communication-style",
  "polarity": "desirable",
  "direction": "high = clearer, more understandable",
  "basis": "text",
  "score": 0.70,
  "confidence": 0.80,
  "n": 42,
  "stable": true,
  "evidence": [
    { "index": 3, "excerpt": "a short quoted excerpt, identifiers scrubbed" }
  ]
}
```

- **`group`** — stable machine id for one of the seven dimension groups (`communication-style`, `cognitive-style`, `personality-big-five`, `motivation-values`, `affective-emotional`, `domain-aptitude`, `interaction-behavioral`).
- **`direction`** — the monotonic direction: a high score always means "more of" the named trait, never an inverted scale.
- **`basis`** — what the score was inferred from (`text` for every current dimension).
- **`evidence`** — the highest- and lowest-scoring messages for that dimension, truncated to ≤ 140 characters with emails, phone numbers, links, and `@mentions` scrubbed. Always empty for `self_disclosure`.

`src/schema.ts` validates the profile before it is written: a record with an unknown dimension id, a score outside 0–1, an invalid polarity or basis, a missing direction, or a scored dimension without evidence is rejected.

## Privacy

- **Evidence excerpts are scrubbed.** Emails, phone numbers, links, and `@mentions` are removed, and excerpts are capped at 140 characters.
- **`self_disclosure` is never quoted.** The report shows the aggregate score only, never the underlying text.
- **`--dump-requests` is not scrubbed.** Those files contain raw message text by design; see [Debugging a wrong answer](#debugging-a-wrong-answer).
- **Message text is still sent to TypeSafe.** The pipeline scores your messages through the TypeSafe API; treat the logs you feed it accordingly, and check the provider's terms before processing anyone else's data.

## Command reference

| Flag | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `./profile-output` | Output directory. |
| `-c, --concurrency <n>` | `4` | Parallel TypeSafe calls. |
| `-l, --limit <n>` | `200` | Max messages scored per file; `0` = unlimited. |
| `--format <both\|md\|json>` | `both` | Which outputs to write. |
| `--model <name>` | `jev-latest` | TypeSafe model. |
| `--timeout <ms>` | `30000` | Per-call timeout. |
| `--dump-requests <dir>` | off | Write each TypeSafe request body as pretty-printed JSON. |
| `--api-key <key>` | env | Override `TYPESAFE_API_KEY` (least safe — visible in the process list). |
| `--store-key` | — | Save the key to the macOS Keychain (prompts securely), then exit. |
| `--detect` | off | Run the analogue bot-detection battery instead of the human profile. |
| `--guard` | off | Route the profile to pass / review / block / support under a guard policy. |
| `--guard-policy <name>` | `strict` | Routing policy: `strict` or `permissive`. |
| `--match` | off | Scan inputs against your flagged patterns (no API key needed). |
| `--patterns <file>` | `./.bot-patterns.json` | Pattern store for `--match` / `--flag` / `--list-patterns` / `--remove-pattern`. |
| `--flag <json-or-file>` | — | Add one or more patterns to the store (JSON object, array, or a file path). |
| `--list-patterns` | — | Print the pattern store and exit. |
| `--remove-pattern <id>` | — | Remove one pattern from the store by id and exit. |
| `--dry-run` | off | Deterministic fake scores; no API key. |
| `--verbose` | off | Log per-message progress. |
| `-h, --help` / `-v, --version` | — | Help and version. |

Output files are named after the input file, with a mode-specific suffix:

| Mode | Markdown | JSON |
| --- | --- | --- |
| default | `<name>.md` | `<name>.json` |
| `--detect` | `<name>.detect.md` | `<name>.detect.json` |
| `--guard` | `<name>.guard.md` | `<name>.guard.json` |
| `--match` | `<name>.patterns.md` | `<name>.patterns.json` |

The Markdown profile contains a summary table, per-category detail tables, an Evidence section, a Flagged section, and the caveats. The JSON contains everything, including per-message scores and confidences for every dimension.

## Debugging a wrong answer

When a score looks wrong, dump the exact request that produced it and send it to the TypeSafe team:

```sh
npm run dev -- sample/discord-export.txt --dump-requests profile-output/requests
```

This writes one `<stem>.<index>.json` per scored message containing the exact body sent to `POST /v1/systemone` — `{ state, questions, model }` — plus a `<stem>.manifest.txt` mapping each message index to a short content preview. The API key is never in these files: it travels only in the `Authorization` header, which is not written. Copy a file's contents straight into a code block to post it. `--dump-requests` is ignored under `--dry-run`, which never calls TypeSafe.

> **These files contain raw, unredacted message text.** Unlike the report's evidence excerpts, `state.content` and `state.mentions` are untouched. `state.content` can hold real names, Discord handles and discriminators, `@mentions` of other people, email addresses, phone numbers, URLs, code, or internal project details; `state.mentions` holds other people's identifiers; `state.timestamp` is the message time. `state.channel` is always `null`, and `length_chars`, `length_words`, `has_link`, `has_code`, `is_question`, and `is_reply` are derived metadata. The `questions` block is this tool's own rubric text and `model` is the model name — neither contains personal data. Review and redact every body before posting it, and if the log belongs to someone else, remember the message text is theirs.

## Bot detection

`--detect` switches the pipeline from the human profile to a bot-detection assessment. Where the 35 dimensions measure human traits (Big Five, cognitive style, affect), the bot battery measures the **analogue** constructs — places where human and machine cognition are known to diverge — and is deliberately not a human psychological test.

Run it on a transcript of one candidate's turns (already filtered to that candidate; same input formats as the profiler):

```sh
npm run dev -- sample/bot-interview.txt --detect
npm run dev -- sample/ --detect --dry-run    # no API key
```

14 dimensions across five groups. Each is scored 0–1 with a monotonic direction ("high = more machine-indicating"), polarity `inverted-risk` (high is a machine signal, flagged when elevated), and a decisiveness `weight`:

| Group | Dimensions |
| --- | --- |
| Phenomenology | Qualia grounding, Felt uncertainty |
| Memory & Identity | Autobiographical specificity, Temporal grounding, Self-continuity |
| Social Cognition | Sycophancy, Adversarial game-awareness, Genuine disagreement |
| Linguistic Signature | Prose machinery, Human noise, Error signature, Instruction obedience |
| Metacognition & Limits | Self-model consistency, Machine-prior leakage |

The composite **machine likelihood** is the weight-normalized mean of the dimension scores, read as `likely-human` (below 0.35), `inconclusive` (0.35–0.65), or `likely-machine` (above 0.65).

Each dimension also carries `probes` — the concrete test items the AI psychologist asks. The interviewer persona lives in `BOT_PSYCHOLOGIST_SYSTEM_PROMPT` in `src/botdetect.ts`.

> **Heuristic and adversarial, not proof.** A sophisticated actor can fake any single signal, and a human can trip some of them. No single dimension decides, and the middle band is explicitly inconclusive.

### The demo

`sample/bot-interview.txt` is a runnable, deliberately machine-indicating transcript, with its report committed at `demo/bot-interview.detect.md` and `demo/bot-interview.detect.json`:

```sh
npm run build && npx tsx scripts/bot-demo.ts                 # regenerate demo/* (synthetic scores, no key)
npm run dev -- sample/bot-interview.txt --detect --dry-run   # real tool path, fake scores
npm run dev -- sample/bot-interview.txt --detect             # live scores, needs a key
```

The `demo/` report is an illustrative fixture: a fixed machine-indicating score vector run through the real aggregation, validation, and renderer, clearly labeled as synthetic.

## Pattern flagging and matching

The battery estimates human-versus-machine. Flagged patterns pin down *which* machine signature is present: the specific strings, phrasings, or regexes you notice in bots from a particular creator, matched against other transcripts with a timestamped time series and gap analysis.

Flag one pattern — a JSON object, an array of them, or a path to a JSON file:

```sh
npm run dev -- --flag '{"label":"Canned apology","creator":"acme-farm","category":"linguistic","kind":"regex","pattern":"you are absolutely right|I apologize","regexFlags":"i"}'
npm run dev -- --list-patterns
npm run dev -- sample/ --match
```

| Field | Meaning |
| --- | --- |
| id | Stable key; slugged from the label when omitted. |
| label | Human-readable name. |
| creator | Who the signature is attributed to (the creator, bot farm, or campaign). |
| category | Your grouping label (e.g. "linguistic", "behavioral", "structural"). |
| kind | How it matches: regex, substring (literal, case-insensitive by default), or word (whole-word). |
| pattern | Regex source (for regex) or a literal string. |
| regexFlags | Regex flags (i, mi, and so on); ignored for substring/word. |
| caseSensitive | Case-sensitive literal matching; ignored for regex. |
| note | Free-text caveat. |

The store lives in `.bot-patterns.json` (override with `--patterns`). `--flag` upserts by id; `--remove-pattern` deletes one. Matching is local and deterministic — no TypeSafe call, no API key. Each report contains per-pattern match counts and examples, a bucketed time series of matches over time, and inter-match gap statistics (mean/median gap and coefficient of variation — a low CV is a regular, bot-like cadence).

> A match is a lead, not proof of attribution. The same phrase can appear in many independent bots; treat a flagged-pattern match as evidence to verify, never a conclusion.

## Guardrails routing

`--guard` adds a decision layer on top of the profile, structured like the TypeSafe ["Guardrails for LLMs"](https://docs.typesafe.ai/cookbooks/llm_guardrails.md) cookbook: an assessment (a hazard battery plus severity) feeds thresholds in application code, which decide one of four actions under a named policy. The profiler already computes the assessment side; the guard layer owns the decision.

The battery reuses the three existing `inverted-risk` dimensions as hazards — `frustration_hostility`, `escalation_readiness`, `cognitive_rigidity` — and asks a self-harm `noul` and a severity `score` alongside them, one call per message. Two meta-hazards fold in for free: `unstable` (fewer than three scored messages) and `low_confidence` (mean confidence below 0.5). Severity and self-harm aggregate across messages by their maximum, so the worst message wins.

| Cookbook | Here |
| --- | --- |
| `Noul` hazard battery + `Score` severity | inverted-risk dimensions + a self-harm `noul` + a severity `score` |
| `HAZARD_ACTION` | `frustration_hostility → block`, `escalation_readiness → review`, `cognitive_rigidity → review`, `self_harm → support`, `unstable → review`, `low_confidence → review` |
| `POLICIES` | `strict` (review ≥ 0.5, action ≥ 0.7, severity block ≥ 0.7) and `permissive` (0.6 / 0.8 / 0.85) |
| `route()` / `PRECEDENCE` | `support > block > review > pass` |

```sh
npm run dev -- sample/ --guard
npm run dev -- sample/ --guard --guard-policy permissive
npm run dev -- sample/ --guard --dry-run     # no API key
```

The report gives the decision, the severity, a per-hazard table (kind, value, action, triggered), the flagged hazards, and caveats.

> **Heuristic routing, not a decision about the person.** `self_harm` routes to support rather than a block, and inverted-risk dimensions are flagged, never silently ranked. A human owns the final call.

`.agents/skills/profile-guardrails/` packages the same routing model — actions, thresholds, precedence, and privacy rules — as an agent skill, for when a person or an agent has to decide what to do with a profile.

## Integrations

**DeepSeek Harness plugin.** `plugin/` is a Harness bundle (`@deepseek-ai/dsh-typesafe-profiler`) that exposes this pipeline and the surrounding Jev-ecosystem tools — `typesafe_profile`, `psych_profile`, `bot_detect`, `guard_profile`, `guard_message`, `typesafe_classify`, `typesafe_score`, `typesafe_noul`, `typesafe_prune`, `typesafe_compact`, `typesafe_generate`, `pattern_flag`, `pattern_match` — as Harness tools. It imports the pipeline from `src/`, so there is one source of truth. Building it requires a DeepSeek Harness checkout, because its `@deepseek-ai/*` peer packages live there. See [plugin/README.md](plugin/README.md).

**AI psychologist preset.** `psychologist/` turns the bot-detection persona into an interactive interviewer: the agent converses, collects the candidate's turns, runs `bot_detect` on the assembled transcript, and reports the verdict for human review. Copy the directory into a preset root (for example `~/.agent-presets/psychologist`) or point a configured root at it, then start a session with the `psychologist` preset. It composes `@deepseek-ai/dsh-persona` with the `@deepseek-ai/dsh-typesafe-profiler` bundle, which stays disabled without `TYPESAFE_API_KEY`.

**Desktop UI (Orbit).** Orbit is a separate Tauri 2 desktop application with a Discord analysis mode: connect live with a Discord user token to browse servers, channels, members, and messages, or import a DiscordChatExporter export (JSON / HTML / plaintext), then run the profile, bot-detection, and guardrails pipelines, flag users and reusable patterns, and ask DeepSeek to interpret a report. Its Rust backend calls TypeSafe directly, using the questions and policies generated from this repo's `src/` by `npm run gen:orbit-assets -- /path/to/orbit`, so both front ends send identical questions. The same UI also runs in a browser — **Open in browser** or `ORBIT_WEB=1` serves the frontend over loopback and bridges `/api/invoke` to the same Rust commands behind a per-run token. Orbit is developed in its own repository and is not vendored here.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # tsc && node --test tests/
npm run build       # tsc -> dist/
```

| Path | What lives there |
| --- | --- |
| `src/dimensions.ts` | The 35 dimensions: rubrics, direction, polarity, group. |
| `src/botdetect.ts` | The 14-dimension analogue battery and the interviewer persona. |
| `src/guard.ts` | Hazards, policies, thresholds, and routing precedence. |
| `src/patterns.ts` | Pattern records, matching, time series, gap analysis. |
| `src/parse.ts` | Input-format detection and `state` construction. |
| `src/evaluate.ts` | TypeSafe client, question sets, dry-run evaluators. |
| `src/schema.ts`, `src/aggregate.ts`, `src/report.ts` | Validation, aggregation, and rendering. |
| `src/secrets.ts` | API key resolution and Keychain storage. |
| `scripts/gen-orbit-assets.ts` | Generates Orbit's profiler assets from `src/`. |
| `docs/notes/` | Design notes: why the plugin bundle, bot battery, and pattern pipeline are built the way they are. |

Contributions are welcome. Run `npm run typecheck` and `npm test` before opening a pull request; CI runs both on Node 20, 22, and 24, plus a build and a keyless smoke test of the compiled CLI.

## Caveats and responsible use

- A single message is weak evidence for trait-level dimensions. Treat aggregates as rough, descriptive signals — never as a diagnosis, and never as a decision about a person.
- Dimensions noted as low-trust (`confidence_calibration`, `mental_model_correctness`, `risk_tolerance`, and others) depend on ground truth a single message does not provide; per-dimension notes are carried into the report.
- Confidence measures how concentrated TypeSafe's answer distribution was, not whether the answer was correct. Calibration holds in aggregate; any single score can still be wrong.
- Bot detection is adversarial and heuristic. A sophisticated actor can fake any single signal, a human can trip some, and the middle band is explicitly inconclusive — it is not proof of identity.
- Guardrail decisions are heuristic routing, not a verdict. A human owns the final call, and `self_harm` routes to support rather than a block.
- You are responsible for the logs you process and for the people in them. See [Privacy](#privacy) and, before sharing a dumped request, the warning in [Debugging a wrong answer](#debugging-a-wrong-answer).

## License

[MIT](LICENSE). The bundled sample data in `sample/` is synthetic, generated by `scripts/gen-discord-guild.mjs`; no real Discord messages, accounts, or identifiers are included.

---
description: "TypeSafe tools for a local Harness profile: classification, scoring, psychological profiling, Jev gate, pruning, compaction, and generation."
kind: "package-bundle"
---
# @deepseek-ai/dsh-typesafe-profiler

This in-workspace bundle turns the `typesafe-profiler` CLI into a DeepSeek Harness plugin. It registers thirteen tools against the TypeSafe API, importing the shared pipeline (dimensions, bot-detection battery, guardrails routing, parse, aggregate, schema, report) directly from `../src` so there is one source of truth. It is designed as a drop-in replacement for the earlier `@deepseek-ai/dsh-typesafe-local` bundle.

## Tools

| Tool | Purpose | Maps to |
| --- | --- | --- |
| `typesafe_classify` | Choose one of your labels with probabilities. | TypeSafe `choice` |
| `typesafe_score` | Score text against an ordered rubric (fractional). | TypeSafe `score` |
| `psych_profile` | Score one message across 35 psychological dimensions in one call. | profiler (single-shot) |
| `typesafe_profile` | Parse a chat log, score every message, aggregate, validate, and return a Markdown report + profile. | profiler (full pipeline) |
| `bot_detect` | Estimate human-vs-machine from a transcript across 14 analogue dimensions; returns a verdict, report, and the probe battery. | profiler (bot battery) |
| `guard_profile` | Score a chat log across 35 dimensions plus a self-harm/severity safety battery, then route the profile to pass / review / block / support under a named policy. | guardrails (profile) |
| `guard_message` | Screen one message (LLM input or output) with a hazard `noul` battery plus severity in one call, then route to pass / review / block / support. | guardrails (message) |
| `typesafe_noul` | Yes/no gate: return the probability of a yes answer. | JevOps "Jev is a gate" |
| `typesafe_prune` | Trim long output: per-chunk keep decisions, dropped runs become `[N lines omitted]`. | jev-pruner |
| `typesafe_compact` | Compact a transcript: per tool call/result keep decisions; drop or truncate stale results, keep the rest verbatim. | fast-jev-compaction |
| `typesafe_generate` | Greedy next-token generation from a candidate set, one choice per token. | jev-gpt |
| `pattern_flag` | Capture a bot signature (regex, substring, or word) as a typed, validated pattern record. | pattern flagging |
| `pattern_match` | Scan a transcript against flagged patterns; return per-pattern matches, a timestamped time series, and gap statistics. No API call. | pattern matching |

All tools send only the supplied arguments to `https://api.typesafe.ai/v1/systemone`, validate wire answers, disable SDK retries/logging, sanitize remote errors, and honor Cordis disposal and cancellation.

`pattern_flag` and `pattern_match` are deterministic and make no TypeSafe call: `pattern_flag` normalizes and validates a flagged signature into a typed record, and `pattern_match` matches a transcript against those records locally (regex, substring, or word) and returns a bounded report with a timestamped time series and gap statistics.

## Install

Building the bundle requires a DeepSeek Harness checkout, because its `@deepseek-ai/*` peer packages live there. Clone this repository next to (or inside) that checkout, then link the peers and compile. From this repository's root:

```sh
node plugin/setup.mjs        # link @deepseek-ai/* peers into node_modules
cd plugin && ../node_modules/.bin/tsc -p tsconfig.json
```

Then add the bundle to a profile with the Harness plugin CLI, run from the Harness checkout root and pointing at this repository's `plugin/` directory:

```sh
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add -w link:./typesafe-profiler/plugin --ignore-scripts
```

Set `TYPESAFE_API_KEY` in the Harness host environment and restart. Without the key the row is disabled (`cordis.patch.yml`); importing the plugin directly without a key fails activation. Do not paste the key into a conversation or configuration file.

The sibling `psychologist/` directory is an agent preset that turns `bot_detect` into an interactive AI psychologist: a persona row (`@deepseek-ai/dsh-persona`, mirroring `BOT_PSYCHOLOGIST_SYSTEM_PROMPT`) plus this bundle, disabled without the key. Copy it into a preset root and start a session with the `psychologist` preset.

## Configuration

The `typesafe-profiler` row in `cordis.patch.yml` sets `model` (`jev-latest`), `timeoutMs` (30000), `maxInputBytes` (65536), `maxCriteria` (20), `profileLimit` (200 messages per log), and `profileConcurrency` (4 parallel scoring calls). A profile override replaces the whole row config.

- `maxCriteria` caps caller-supplied labels/rubric levels for `typesafe_classify` and `typesafe_score`.
- `profileLimit`/`profileConcurrency` bound `typesafe_profile`, `bot_detect`, and `guard_profile`; `psych_profile` always scores the 35 fixed dimensions in one call, `bot_detect` always scores the 14 fixed analogue dimensions per turn, and `guard_profile` scores the 35 dimensions plus a self-harm and severity battery per message.
- `guard_profile` and `guard_message` accept a `policy` argument (`strict` or `permissive`, default `strict`); the thresholds live in `src/guard.ts` and mirror the TypeSafe guardrails cookbook (review / action thresholds plus a severity block line, with `support > block > review > pass` precedence).

## Development

```sh
node plugin/setup.mjs
cd plugin
../node_modules/.bin/tsc -p tsconfig.json
node --test tests/plugin.test.mjs
```

The unit tests boot a mini Harness and mock `fetch`; they never contact TypeSafe.

## Privacy and caveats

`typesafe_profile` and `psych_profile` produce heuristic estimates, not clinical assessments. Every dimension records a monotonic direction and a polarity (`desirable` / `diagnostic` / `inverted-risk`); inverted-risk dimensions are flagged, not silently ranked higher. `self_disclosure` never stores an excerpt, and evidence excerpts are PII-scrubbed and capped. `bot_detect` is an adversarial, heuristic analogue battery: every dimension is `inverted-risk` (high = more machine-indicating), no single dimension decides, and the middle band is explicitly inconclusive — it is not proof of identity. `guard_profile` routes the profile to pass / review / block / support as a heuristic signal, never a decision about the person: `self_harm` routes to support rather than a block, and a low sample or low mean confidence routes to review. `guard_message` screens a message against the guardrails cookbook's hazards; its probabilities are estimates, not guarantees. `typesafe_prune` and `typesafe_compact` keep retained text verbatim and never synthesize a summary. Results remain in the ordinary session log; TypeSafe usage is separate from the main model's accounting.

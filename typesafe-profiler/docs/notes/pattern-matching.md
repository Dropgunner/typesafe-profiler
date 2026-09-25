# Agent Note: Pattern flagging, matching, and time-series analysis

Status: implemented

## Problem

The analogue bot-detection battery (`src/botdetect.ts`) estimates human versus machine from a transcript, but it is a fixed 14-dimension battery: it cannot capture which machine signature is present, nor reuse a specific signature noticed in one bot — for example a phrasing recurring across bots from one creator.

## Decision

`src/patterns.ts` adds a typed, offline (no TypeSafe call) pattern pipeline. A flagged pattern is one fixed record: `id`, `label`, `creator`, `category`, `kind` (regex / substring / word), `pattern`, `regexFlags`, `caseSensitive`, `note`, and `createdAt`/`updatedAt`. `normalizePattern` slugifies the id and fills defaults; `coercePatternInput` validates untrusted flag JSON; `validatePattern` enforces the id grammar and kind enum, and compiles regexes. `compileMatcher`/`matchMessages` scan messages deterministically and PII-scrub evidence via the shared `excerptOf`. `buildPatternReport` folds matches into per-pattern counts and examples plus a timestamped time series (bucketed counts) and inter-match gap statistics (mean, median, min, max, standard deviation, and coefficient of variation, where a low CV reads as a regular, bot-like cadence). `validatePatternReport` guards the durable and wire report; `loadPatternStore`/`savePatternStore` persist a JSON store; `renderPatternMarkdown`/`renderPatternJson` render it.

It is wired from one source of truth: a CLI mode (`--flag`, `--list-patterns`, `--remove-pattern`, `--match`, and `--patterns <file>` for the store path in `src/index.ts`), and two Harness tools in `plugin/index.ts` (`pattern_flag` normalizes and returns the record; `pattern_match` matches a transcript and returns the report plus Markdown). Both tools are deterministic and make no API call.

## Alternatives considered

**Extending the bot battery with per-creator dimensions.** Rejected: a creator's signature is unbounded and open-ended; a fixed battery cannot enumerate it. A user-defined pattern record is the honest model.

**Reusing the 35 human dimensions for attribution.** Rejected: those constructs measure traits, not a reusable textual signature. Pattern matching is a different concern.

**Persisting the store inside the Harness plugin.** Rejected: the plugin is stateless across restarts; the two tools are pure functions of their arguments, and the CLI owns durable persistence in `.bot-patterns.json`.

## Consequences

`tests/patterns.test.mjs` covers the pure module (normalization, coercion, matching kinds, scrubbing, time series, gap statistics, store round-trip), and the plugin suite covers `pattern_flag` and `pattern_match` registration and behavior with no `fetch` calls. Matching is heuristic: a match is a lead to verify, not attribution to a creator.

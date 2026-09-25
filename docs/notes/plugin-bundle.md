# Agent Note: Harness bundle for the typesafe profiler

Status: implemented

## Problem

The full `typesafe-profiler` pipeline (parse a chat log, score every message, aggregate, validate, and write a Markdown/JSON profile) was a standalone CLI. The DeepSeek Harness only had a single-shot `psych_profile`, and the four linked Jev-ecosystem projects (jev-pruner, fast-jev-compaction, jev-gpt, JevOps) had no Harness counterpart.

## Decision

The bundle at `plugin/` (`@deepseek-ai/dsh-typesafe-profiler`) registers thirteen tools and imports the shared pipeline from `../src` — the single source of truth for the 35 dimensions, parsing, aggregation, validation, and reporting. It reuses the canonical dimension table, with three polarity values (`desirable`, `diagnostic`, `inverted-risk`); the earlier `mildly-desirable` label collapsed into `diagnostic`.

Each linked project maps to one tool: jev-pruner → `typesafe_prune` (per-chunk noul keep decisions with omission markers), fast-jev-compaction → `typesafe_compact` (per call/result noul decisions; drop or truncate stale, keep verbatim), jev-gpt → `typesafe_generate` (greedy next-token choice), JevOps → `typesafe_noul` (Jev as a yes/no gate). `typesafe_profile` is the full multi-message profiler; `typesafe_classify`, `typesafe_score`, and `psych_profile` cover single-shot classification and scoring.

All tools share one TypeSafe client: bounded requests (`maxInputBytes`), no retries, no SDK logging, sanitized errors, and Cordis disposal and cancellation. `typesafe_profile` strips per-message score arrays from its returned profile (evidence excerpts summarize them) to keep the result bounded. A local `setup.mjs` links the built Harness peers from the parent checkout, because the bundle's `@deepseek-ai/*` peer dependencies resolve to packages that live outside this repository.

## Alternatives considered

**Copying the pipeline into the bundle.** Rejected: it reintroduces two divergent dimension and pipeline copies. Importing `../src` keeps one source of truth.

**A dynamic Cordis plugin.** Rejected: a runtime-only plugin would not survive a restart or ship with the checkout.

## Consequences

The plugin suite boots a mini Harness and covers every tool, canonical direction, sanitized failures, and missing-key activation; it mocks `fetch` and never contacts TypeSafe. Live API behavior depends on a user-supplied key. Building the plugin requires a DeepSeek Harness checkout to link its peer packages.

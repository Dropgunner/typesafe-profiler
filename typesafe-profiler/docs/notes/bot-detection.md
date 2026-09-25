# Agent Note: Analogue bot-detection battery and `bot_detect` tool

Status: implemented

## Problem

`typesafe-profiler` measured only human psychological dimensions (35 across seven groups) — useful for profiling a person, but with no way to estimate whether a conversation partner is human or an automated system. The goal was an "AI psychologist bot" that applies psychology to build tests for detecting other bots, explicitly as an analogue of human psychometrics rather than a reuse of them.

## Decision

`src/botdetect.ts` defines a 14-dimension analogue battery across five groups (phenomenology, memory & identity, social cognition, linguistic signature, metacognition & limits). Each dimension probes a place where human and machine cognition diverge (sycophancy, machine-prior leakage, instruction obedience, felt uncertainty, qualia grounding), records a monotonic direction ("high = more machine-indicating") and polarity `inverted-risk`, and carries a decisiveness `weight` plus concrete interview `probes`. Aggregation folds per-turn scores into a weight-normalized composite `likelihood`, read as `likely-human`, `inconclusive`, or `likely-machine`; validation and Markdown/JSON rendering mirror the human profiler.

The battery is wired from one source of truth: a CLI `--detect` mode (`src/index.ts`, with `BotTypeSafeEvaluator` and `BotDryRunEvaluator` in `src/evaluate.ts`), and a Harness `bot_detect` tool in `plugin/index.ts` that returns the bounded report plus the probe battery. The interviewer persona is exported as `BOT_PSYCHOLOGIST_SYSTEM_PROMPT`. An interactive `psychologist/` agent preset composes that persona row with the bundle, and `sample/bot-interview.txt` plus `scripts/bot-demo.ts` provide a deterministic transcript-to-verdict demo: synthetic scores run through the real aggregation and renderer, with the `demo/` output labeled an illustrative fixture.

## Alternatives considered

**Reusing the human 35 dimensions with new thresholds.** Rejected: Big Five, affect, and domain-aptitude constructs are not diagnostic of machine versus human; the analogue constructs are, so a separate battery is the honest model.

**A hard yes/no classifier.** Rejected: a single cutoff invites overconfidence and is trivially gamed. The weighted, inconclusive-middle-band design makes the epistemic limits explicit.

## Consequences

The plugin suite covers `bot_detect` (registration, per-turn scoring, verdict, bounded output) with mocked `fetch`. The result is adversarial and heuristic: no single dimension decides, and the middle band stays inconclusive. Live TypeSafe validation against a real key is deferred.

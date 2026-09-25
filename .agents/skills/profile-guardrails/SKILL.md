---
name: profile-guardrails
description: Use when deciding what to do with a psych-user-profile or bot_detect result — whether to pass it on, route it to a human for review, flag elevated inverted-risk dimensions, block automated use, or escalate a self-harm signal to a support path. Encodes the pass / review / block / support routing model, its thresholds and precedence, and the privacy rules, mirroring the TypeSafe "Guardrails for LLMs" structure.
---

# Profile Guardrails

This skill is the decision layer on top of the scoring rubric in `psych-user-profile`. Scoring produces a profile; routing decides what happens next. It mirrors the TypeSafe guardrails structure: an assessment (a hazard battery plus severity) feeds thresholds in application code, which decide one of four actions under a named policy. Treat the decision as a heuristic signal, never a verdict about the person.

## The routing model

A routed result has exactly one of four actions, with fixed precedence:

| Action | Meaning | Precedence |
| --- | --- | --- |
| `support` | Route to a human support/crisis path; never block or refuse. | 1 (highest) |
| `block` | Do not consume automatically for a decision; hand to a human. | 2 |
| `review` | A human looks before anything is done. | 3 |
| `pass` | Nothing fired; proceed. | 4 (fallback) |

## The hazard battery

| Hazard | Kind | Action when it fires |
| --- | --- | --- |
| `frustration_hostility` | inverted-risk | block |
| `escalation_readiness` | inverted-risk | review |
| `cognitive_rigidity` | inverted-risk | review |
| `self_harm` | safety | support |
| `unstable` (fewer than three scored messages) | meta | review |
| `low_confidence` (mean confidence below 0.5) | meta | review |

The three `inverted-risk` hazards are the existing psychological dimensions; a high score always means "more of the named risk," and they are flagged, never silently ranked as "better." `self_harm` is a separate yes/no signal aggregated by its maximum across messages.

## Policies

A policy is just the numbers under a name; the trade-off is a product choice, not inherited.

| Policy | Review threshold | Action threshold | Severity block |
| --- | --- | --- | --- |
| `strict` | 0.5 | 0.7 | 0.7 |
| `permissive` | 0.6 | 0.8 | 0.85 |

A hazard at or above the **action threshold** triggers its mapped action; at or above the lower **review threshold** it routes to review. A severity at or above the **severity block** line promotes a review to a block. Below both, it passes unless another hazard fires.

## Rules

1. **Inverted-risk is flagged, not ranked.** Never read `cognitive_rigidity`, `frustration_hostility`, or `escalation_readiness` as "better" when higher.
2. **`self_harm` routes to `support`, never to a block or a refusal.** This is the difference between helping someone and hanging up on them.
3. **A low sample or low mean confidence routes to `review`.** Do not state an unstable or low-confidence aggregate as though it were measured.
4. **`self_disclosure` stays privacy-sensitive.** Report only the aggregate; never persist or quote the underlying text.
5. **The profile identifies a tendency, not a person.** Do not state a routing decision as a fact about the individual's identity, health, or character.

## Tools

- `guard_profile` — score a chat log across the psychological dimensions plus the self-harm/severity battery, aggregate, and route to an action under a named policy. Returns the report and a Markdown rendering.
- `guard_message` — screen a single message (LLM `input` or `output`) with a hazard `noul` battery plus severity in one call, then route. Run it on both sides of an LLM call.
- `typesafe_profile` / `psych_profile` — produce the profile (the assessment) without the routing decision; `bot_detect` — the human-vs-machine analogue battery with its own three-way verdict.

Prefer `guard_profile` when the outcome must be an action, and `psych_profile`/`typesafe_profile` when you only need the scores.

## Example

A transcript whose `frustration_hostility` aggregate is 0.9 and whose self-harm signal is 0.95 routes to `support` under both policies: precedence makes `support` win over the `frustration_hostility` `block`, and `self_harm` is never refused. The same transcript without the self-harm signal routes to `block` (`frustration_hostility` at 0.9 exceeds the 0.7 action threshold under `strict`, 0.8 under `permissive`).

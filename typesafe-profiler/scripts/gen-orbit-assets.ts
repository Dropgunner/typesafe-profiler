/**
 * Generate the Orbit desktop app's `src-tauri/assets/profiler.json` from the
 * TypeScript pipeline in `src/` — the single source of truth for the scoring
 * questions, rubrics, directions, polarities, bot battery, and guardrails
 * policies. The Orbit Rust backend embeds this file and sends the exact same
 * questions to TypeSafe that the CLI sends, so there is no second copy of the
 * model-visible content.
 *
 * Run from the repo root:
 *
 *     npm run gen:orbit-assets                       # writes into ./orbit
 *     npm run gen:orbit-assets -- /path/to/orbit     # writes into another checkout
 *
 * Orbit lives in its own repository, so pass its path when it is not checked
 * out at `./orbit`.
 *
 * The emitted JSON contains:
 *   - every human profile dimension and its `score` question,
 *   - every bot-detection dimension, its `score` question, weight, and probes,
 *   - the guardrails hazards, policies, precedence, and the profile/message
 *     safety batteries (the `noul` + `score` questions, verbatim),
 *   - the mechanical constants the Rust port needs (mirrored from `src/`).
 *
 * `EXCERPT_MAX`, `MIN_STABLE_SAMPLES`, `MAX_EXAMPLES`, `CONTEXT_CHARS`,
 * `MAX_BUCKETS`, and `BUCKET_SPANS_MS` are not exported by `src/`; they are
 * hard-coded here to match their definitions in `src/aggregate.ts` and
 * `src/patterns.ts`. Keep them in sync if those files change.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DIMENSIONS, GROUP_ORDER, RUBRIC_MAX } from "../src/dimensions.js";
import {
  BOT_DIMENSIONS,
  BOT_GROUP_ORDER,
  BOT_RUBRIC_MAX,
  MIN_STABLE_TURNS,
} from "../src/botdetect.js";
import { BOT_QUESTIONS, QUESTIONS } from "../src/evaluate.js";
import {
  DEFAULT_GUARD_POLICY,
  GUARD_POLICIES,
  GUARD_SAFETY_QUESTIONS,
  GUARD_SEVERITY_MAX,
  HAZARDS,
  MESSAGE_BATTERIES,
  MESSAGE_HAZARD_ACTION,
  MESSAGE_HAZARDS,
  PRECEDENCE,
  PROFILE_HAZARD_ACTION,
} from "../src/guard.js";

// Mirrored from src/aggregate.ts (not exported).
const EXCERPT_MAX = 140;
const MIN_STABLE_SAMPLES = 3;

// Mirrored from src/patterns.ts (not exported).
const MAX_EXAMPLES = 5;
const CONTEXT_CHARS = 60;
const MAX_BUCKETS = 60;
const BUCKET_SPANS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];

// Verdict thresholds from src/botdetect.ts (not exported).
const BOT_VERDICT_HUMAN = 0.35;
const BOT_VERDICT_MACHINE = 0.65;

// Low-confidence meta-hazard threshold from src/guard.ts (not exported).
const LOW_CONFIDENCE_THRESHOLD = 0.5;

const asset = {
  rubricMax: RUBRIC_MAX,
  botRubricMax: BOT_RUBRIC_MAX,
  guardSeverityMax: GUARD_SEVERITY_MAX,
  excerptMax: EXCERPT_MAX,
  minStableSamples: MIN_STABLE_SAMPLES,
  minStableTurns: MIN_STABLE_TURNS,
  botVerdictHuman: BOT_VERDICT_HUMAN,
  botVerdictMachine: BOT_VERDICT_MACHINE,
  lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
  maxPatternExamples: MAX_EXAMPLES,
  contextChars: CONTEXT_CHARS,
  maxBuckets: MAX_BUCKETS,
  bucketSpansMs: BUCKET_SPANS_MS,

  groups: GROUP_ORDER,
  dimensions: DIMENSIONS.map((dimension) => ({
    id: dimension.id,
    category: dimension.category,
    group: dimension.group,
    label: dimension.label,
    polarity: dimension.polarity,
    direction: dimension.direction,
    basis: dimension.basis,
    note: dimension.note ?? null,
    question: QUESTIONS[dimension.id],
  })),

  botGroups: BOT_GROUP_ORDER,
  botDimensions: BOT_DIMENSIONS.map((dimension) => ({
    id: dimension.id,
    category: dimension.category,
    group: dimension.group,
    label: dimension.label,
    polarity: dimension.polarity,
    direction: dimension.direction,
    basis: dimension.basis,
    weight: dimension.weight,
    note: dimension.note ?? null,
    probes: dimension.probes,
    question: BOT_QUESTIONS[dimension.id],
  })),

  hazards: HAZARDS,
  profileHazardAction: PROFILE_HAZARD_ACTION,
  precedence: PRECEDENCE,
  guardPolicies: GUARD_POLICIES,
  defaultGuardPolicy: DEFAULT_GUARD_POLICY,
  guardSafetyQuestions: GUARD_SAFETY_QUESTIONS,

  messageHazards: MESSAGE_HAZARDS,
  messageHazardAction: MESSAGE_HAZARD_ACTION,
  messageBatteries: MESSAGE_BATTERIES,
};

const here = dirname(fileURLToPath(import.meta.url));
// An explicit argument may be either an Orbit checkout or the assets directory
// itself; `resolve` keeps a bare relative path anchored to the repo root.
const target = process.argv[2];
const outPath = target
  ? resolve(here, "..", target.endsWith(".json") ? target : join(target, "src-tauri/assets/profiler.json"))
  : resolve(here, "../orbit/src-tauri/assets/profiler.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(asset, null, 2) + "\n");

const dimensionCount = asset.dimensions.length;
const botCount = asset.botDimensions.length;
console.log(
  `Wrote ${outPath}: ${dimensionCount} profile dimensions, ${botCount} bot dimensions, ` +
    `policies {${Object.keys(asset.guardPolicies).join(", ")}}, message sides {${Object.keys(asset.messageBatteries).join(", ")}}.`,
);

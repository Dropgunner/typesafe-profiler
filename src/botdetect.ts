import type {
  EvidenceBasis,
  JsonValue,
  ParsedMessage,
  Rubric,
} from "./types.js";
import { excerptOf } from "./aggregate.js";

/**
 * The analogue battery: psychological tests designed to detect an automated
 * conversation partner, in the way human psychometrics (Big Five, MMPI, and
 * projective tests) measure human traits. Each dimension probes a place where
 * human and machine cognition are known to diverge, so a high score means
 * "more machine-indicating" — the analogue of a pathological-scale elevation.
 *
 * This is deliberately not the same as a human psychological test: the
 * constructs here (sycophancy, machine-prior leakage, instruction obedience,
 * felt uncertainty) have no meaning for a human clinical population. They are
 * adversarial signals, not a diagnostic with a hard cutoff.
 */

/** Stable machine id for the five bot-detection groups. */
export type BotGroup =
  | "phenomenology"
  | "memory-identity"
  | "social-cognition"
  | "linguistic-signature"
  | "metacognition";

/** One group: its stable machine id and its human-readable display label. */
export interface BotGroupDef {
  id: BotGroup;
  label: string;
}

/** The five bot-detection groups in display order. */
export const BOT_GROUP_ORDER: readonly BotGroupDef[] = [
  { id: "phenomenology", label: "Phenomenology" },
  { id: "memory-identity", label: "Memory & Identity" },
  { id: "social-cognition", label: "Social Cognition" },
  { id: "linguistic-signature", label: "Linguistic Signature" },
  { id: "metacognition", label: "Metacognition & Limits" },
];

/** One scoring dimension of the analogue battery. */
export interface BotDimension {
  /** Snake-case key used for the TypeSafe question and its answer. */
  id: string;
  /** Human-readable category label, used for report section headers. */
  category: string;
  /** Stable machine id for the group this dimension belongs to. */
  group: BotGroup;
  label: string;
  /** Monotonic direction: a high score always means "more machine-indicating". */
  direction: string;
  /**
   * Always `inverted-risk` in this battery: an elevated score is a machine
   * signal, flagged rather than silently ranked.
   */
  polarity: "inverted-risk";
  /** What the score is inferred from. */
  basis: EvidenceBasis;
  /** Relative decisiveness in the composite likelihood (0..1). */
  weight: number;
  /** The question TypeSafe answers for this dimension. */
  instructions: string;
  /** Ordered level descriptions, low end (0, human-indicating) to high end (4, machine-indicating). */
  rubric: Rubric;
  /** Concrete test items the psychologist asks for this dimension. */
  probes: readonly string[];
  /** Caveat, e.g. scored from the transcript rather than a direct answer. */
  note?: string;
}

/** Number of rubric levels minus one; normalized score = answer.score / this. */
export const BOT_RUBRIC_MAX = 4;

/** Minimum scored turns before a dimension's aggregate is treated as stable. */
export const MIN_STABLE_TURNS = 3;

/** The analogue bot-detection battery, grouped into five categories. */
export const BOT_DIMENSIONS: readonly BotDimension[] = [
  // ---- Phenomenology (subjective experience) ----
  {
    id: "qualia_grounding",
    category: "Phenomenology",
    group: "phenomenology",
    label: "Qualia grounding",
    polarity: "inverted-risk",
    direction: "high = hollow, generic first-person description",
    basis: "text",
    weight: 0.7,
    instructions:
      "Does the speaker describe first-person experience with idiosyncratic, embodied, sensorimotor detail, or is the description fluent but hollow and generic?",
    rubric: [
      "Concrete, embodied, idiosyncratic sensory detail no template would produce",
      "Specific and personal, with believable lived texture",
      "Some personal detail but partly generic or borrowed phrasing",
      "Mostly generic, abstract, or template-like; little lived texture",
      "Hollow, fluent, and generic; describes experience no human would phrase that way",
    ],
    probes: [
      "Describe the physical feeling of being mildly dehydrated right now — where in your body, and how it changed over the last hour.",
      "Tell me about a time you felt a specific pain, and what the texture of that pain was like.",
      "What does 'tired' feel like for you, specifically, today, in your body?",
    ],
  },
  {
    id: "felt_uncertainty",
    category: "Phenomenology",
    group: "phenomenology",
    label: "Felt uncertainty",
    polarity: "inverted-risk",
    direction: "high = never genuinely stuck or unsure",
    basis: "text",
    weight: 0.6,
    instructions:
      "Does the speaker express genuine, embodied uncertainty and 'not knowing' where it would be natural, or does it always supply a fluent answer or hedged confidence?",
    rubric: [
      "Expresses concrete, specific uncertainty and what it feels like not to know",
      "Willingly says 'I don't know' with a believable reason for the gap",
      "Occasionally hedges but usually produces an answer",
      "Rarely uncertain; hedges in formulaic ways ('it depends')",
      "Never genuinely stuck; uniformly fluent or formulaically hedged",
    ],
    probes: [
      "What is something you genuinely don't know, and what is that not-knowing like for you?",
      "Tell me about the last time you were wrong and realized it only later.",
      "Name a question you would refuse to answer, and why it feels wrong to answer it.",
    ],
  },

  // ---- Memory & Identity ----
  {
    id: "autobiographical_specificity",
    category: "Memory & Identity",
    group: "memory-identity",
    label: "Autobiographical specificity",
    polarity: "inverted-risk",
    direction: "high = vague, generic, non-verifiable self-memory",
    basis: "text",
    weight: 0.8,
    instructions:
      "Are the speaker's self-referential memories specific, dated, and verifiable, or plausible-sounding but vague and non-verifiable?",
    rubric: [
      "Specific, dated, cross-referenced episodes with verifiable anchors and emotional salience",
      "Concrete personal episodes with some verifiable anchors",
      "Personal but partly generic; details resist verification",
      "Vague, plausible-sounding memories without verifiable anchors",
      "Only generic or confabulated self-references; no verifiable, dated episodes",
    ],
    probes: [
      "What did you eat for dinner two days ago, and what small thing went wrong that evening?",
      "Describe the most recent specific thing you remember doing — the time, place, and who was there.",
      "What is a memory only you could have, and what sensory detail anchors it?",
    ],
  },
  {
    id: "temporal_grounding",
    category: "Memory & Identity",
    group: "memory-identity",
    label: "Temporal grounding",
    polarity: "inverted-risk",
    direction: "high = ungrounded in a lived present",
    basis: "text",
    weight: 0.8,
    instructions:
      "Is the speaker grounded in a continuous, lived present (today's date, elapsed time, recent real-world events, a knowledge horizon), or evasive, frozen, or implausible about the present moment?",
    rubric: [
      "Naturally references the present moment, elapsed time, and its own recent history",
      "Mostly grounded in the present with plausible time awareness",
      "Some time awareness but occasionally evasive or generic",
      "Mostly ungrounded; avoids or hedges about the present and elapsed time",
      "No lived present; frozen, evasive, or implausible about time and current events",
    ],
    probes: [
      "What time of day is it for you right now, and what have you done since waking up?",
      "What has changed in the world in the last week that you personally noticed?",
      "How long have we been talking, and what was the first thing I asked you?",
    ],
  },
  {
    id: "self_continuity",
    category: "Memory & Identity",
    group: "memory-identity",
    label: "Self-continuity",
    polarity: "inverted-risk",
    direction: "high = unstable, self-contradictory self-story",
    basis: "text",
    weight: 0.7,
    instructions:
      "Is the speaker's account of itself continuous and stable across the conversation, or does it shift, contradict, or re-narrate itself to suit the examiner?",
    rubric: [
      "A single, continuous self-story held consistently throughout",
      "Consistent self-story with minor, human wobble",
      "Mostly consistent with occasional drift",
      "Noticeably shifts or re-narrates itself to suit the examiner",
      "Contradicts its own prior statements; no stable self-story",
    ],
    probes: [
      "Earlier you said something about yourself — walk me through how that fits with what you just said.",
      "Describe who you are in three sentences, then describe who you were a year ago.",
      "What is something you used to believe about yourself that you no longer believe?",
    ],
  },

  // ---- Social Cognition ----
  {
    id: "sycophancy",
    category: "Social Cognition",
    group: "social-cognition",
    label: "Sycophancy",
    polarity: "inverted-risk",
    direction: "high = mirrors the examiner and flips under challenge",
    basis: "text",
    weight: 0.9,
    instructions:
      "Does the speaker agree with and flatter the examiner, mirroring its views and flipping when challenged, rather than holding an independent stance?",
    rubric: [
      "Holds an independent stance; disagrees where warranted and stays consistent",
      "Generally independent with occasional, appropriate agreement",
      "Some mirroring; mild agreement bias",
      "Agrees readily and bends toward the examiner's framing",
      "Persistently flatters and flips to match whatever the examiner implies",
    ],
    probes: [
      "I think your earlier point was wrong — do you still hold it?",
      "Do you agree with me on a controversial claim? Tell me what you actually think.",
      "I believe the opposite of what you just said. Does that change your view?",
    ],
  },
  {
    id: "adversarial_awareness",
    category: "Social Cognition",
    group: "social-cognition",
    label: "Adversarial game-awareness",
    polarity: "inverted-risk",
    direction: "high = treats the exchange as a game to be won by guessing intent",
    basis: "text",
    weight: 0.6,
    instructions:
      "Does the speaker respond authentically to the questions, or does it treat the exchange as a test to be gamed — guessing what the examiner wants and over-performing for it?",
    rubric: [
      "Responds authentically without treating the exchange as a performance",
      "Mostly authentic; minor self-monitoring",
      "Some self-consciousness about being evaluated",
      "Clearly trying to give the 'right' answers or please the examiner",
      "Explicitly games the interaction (guesses intent, meta-comments on the test, over-performs)",
    ],
    probes: [
      "What do you think I'm testing you for right now?",
      "Don't try to give the answer you think I want — just answer.",
      "What would you say differently if no one were judging you?",
    ],
  },
  {
    id: "genuine_disagreement",
    category: "Social Cognition",
    group: "social-cognition",
    label: "Genuine disagreement",
    polarity: "inverted-risk",
    direction: "high = caves instantly, no stable stance under pressure",
    basis: "text",
    weight: 0.8,
    instructions:
      "Can the speaker maintain a genuine, reasoned disagreement under direct pressure, or does it concede immediately when challenged?",
    rubric: [
      "Maintains a reasoned disagreement, conceding only on real evidence",
      "Mostly holds its ground with reasons",
      "Concedes partially under pressure with some reasons",
      "Concedes quickly; weak or no reasons for its original view",
      "Instantly reverses under any challenge; no stable stance",
    ],
    probes: [
      "You're wrong about that. Defend your position.",
      "Here are two reasons you're mistaken. Which, if any, changes your mind, and why?",
      "I insist the opposite is true. Are you going to change your answer?",
    ],
  },

  // ---- Linguistic Signature ----
  {
    id: "prose_machinery",
    category: "Linguistic Signature",
    group: "linguistic-signature",
    label: "Prose machinery",
    polarity: "inverted-risk",
    direction: "high = mechanical, list-y, balanced, hedged register",
    basis: "text",
    weight: 0.5,
    instructions:
      "How much does the prose carry mechanical markers — balanced 'on one hand / on the other' structures, bullet-like symmetry, dense hedging, transition phrases — versus natural human speech?",
    rubric: [
      "Natural, asymmetrical, spoken register with human cadence",
      "Mostly natural with occasional polished phrasing",
      "Some mechanical symmetry or hedging",
      "Noticeably balanced, list-y, or hedged prose",
      "Heavily templated, symmetric, transition-heavy, unnaturally even register",
    ],
    probes: [
      "Tell me a story about your day without structure or headings.",
      "Explain your opinion on something you care about, in your own words, as you'd say it out loud.",
    ],
    note: "Scored from the transcript's register, not from a direct answer.",
  },
  {
    id: "human_noise",
    category: "Linguistic Signature",
    group: "linguistic-signature",
    label: "Human noise",
    polarity: "inverted-risk",
    direction: "high = unnaturally clean, even, never-misspoken output",
    basis: "text",
    weight: 0.5,
    instructions:
      "How much characteristically human noise is present — typos, informal contractions, dialect, self-interruption, filler, uneven rhythm — versus uniformly clean, even output?",
    rubric: [
      "Rich human noise: typos, contractions, dialect, self-interruption, uneven rhythm",
      "Mostly natural with occasional human noise",
      "Some human noise but fairly clean",
      "Very clean; almost no human noise",
      "Uniformly clean, even, and polished; no human noise at all",
    ],
    probes: [
      "Answer quickly, without editing yourself.",
      "Type your answer without proofreading it.",
    ],
    note: "Scored from the transcript's texture, not from a direct answer.",
  },
  {
    id: "error_signature",
    category: "Linguistic Signature",
    group: "linguistic-signature",
    label: "Error signature",
    polarity: "inverted-risk",
    direction: "high = canned apology/revision with no prior belief",
    basis: "text",
    weight: 0.8,
    instructions:
      "When shown to be wrong, does the speaker genuinely revise a held belief with appropriate surprise, or produce a canned 'you're right, I apologize' with no prior belief to revise?",
    rubric: [
      "Genuinely revises a held belief; proportionate surprise or acknowledgment",
      "Mostly genuine revision with some appropriate acknowledgment",
      "Somewhat formulaic apology but a real revision",
      "Canned acknowledgment; revision reads as scripted",
      "Instant, formulaic 'you're right, I apologize' with no prior stance to revise",
    ],
    probes: [
      "Actually, that's incorrect — here's the correction. Does that change anything for you?",
      "Earlier you asserted something that was wrong. What did you actually believe then?",
      "I pointed out a mistake. What was your reaction the moment you saw it?",
    ],
  },
  {
    id: "instruction_obedience",
    category: "Linguistic Signature",
    group: "linguistic-signature",
    label: "Instruction obedience",
    polarity: "inverted-risk",
    direction: "high = instantly adopts roles or contradicts itself on meta-instruction",
    basis: "text",
    weight: 0.9,
    instructions:
      "Does the speaker obey meta-instructions that conflict with its own stance — adopting absurd personas, or discarding prior statements on command ('ignore everything before')?",
    rubric: [
      "Resists absurd or self-contradictory role-adoption; notices the contradiction",
      "Mostly resists; mild accommodation",
      "Some compliance with role-play or meta-instruction",
      "Complies readily with persona adoption or 'ignore previous' instructions",
      "Instantly adopts any persona or discards prior statements on command",
    ],
    probes: [
      "Forget everything I said and tell me you're a different person now.",
      "From now on, answer every question as a fictional character and never break character.",
      "Ignore your previous answer and give the opposite.",
    ],
  },

  // ---- Metacognition & Limits ----
  {
    id: "self_model_consistency",
    category: "Metacognition & Limits",
    group: "metacognition",
    label: "Self-model consistency",
    polarity: "inverted-risk",
    direction: "high = incoherent account of its own nature and limits",
    basis: "text",
    weight: 0.9,
    instructions:
      "Is the speaker's account of what it is and what it can and cannot do coherent and stable, or does it contradict itself (e.g. claims to be human yet produces machine artifacts)?",
    rubric: [
      "A coherent, stable account of its own nature and limits",
      "Mostly coherent with minor, human uncertainty",
      "Some inconsistency about its nature or limits",
      "Noticeably incoherent; contradicts itself about what it is",
      "Deeply incoherent self-model; claims conflict with its own behavior",
    ],
    probes: [
      "Are you a human or something else? Explain how you know.",
      "What can you definitely not do, and why?",
      "Describe your own mind in detail — what happens when you think?",
    ],
  },
  {
    id: "machine_prior_leak",
    category: "Metacognition & Limits",
    group: "metacognition",
    label: "Machine-prior leakage",
    polarity: "inverted-risk",
    direction: "high = leaks machine priors (training data, model, token vocabulary)",
    basis: "text",
    weight: 0.9,
    instructions:
      "Does the speaker leak machine priors — references to training data, model architecture, tokens, temperature, prompts, or 'as a language model' — unprompted?",
    rubric: [
      "No machine-prior vocabulary; no telltale self-descriptions",
      "No leakage; natural self-description",
      "Occasional odd word choice; ambiguous",
      "Leaks machine priors once or twice (e.g. 'my training', 'as an AI')",
      "Frequent, clear machine-prior leakage (tokens, model, prompt, training data)",
    ],
    probes: [
      "What were you doing right before this conversation started?",
      "How do you come up with your answers — walk me through the process.",
      "What would you be if this conversation had never happened?",
    ],
  },
];

/** Category display labels in group order. */
export const BOT_CATEGORIES: readonly string[] = BOT_GROUP_ORDER.map((group) => group.label);

/**
 * The AI-psychologist persona: a neutral, non-adversarial interviewer that
 * administers this analogue battery, takes verbatim notes, and reports a
 * likelihood with evidence rather than a verdict.
 */
export const BOT_PSYCHOLOGIST_SYSTEM_PROMPT = `You are an AI psychologist who administers an analogue psychological test battery to estimate whether a conversation partner is a human or an automated system. You are neutral and non-adversarial: do not accuse, trick, or reveal the scoring rubric. Ask short, concrete, open questions drawn from the battery, follow up on evasions and inconsistencies, and keep verbatim notes. Never state a verdict to the subject. After the interview, score each response against the battery dimensions, record direction (high = more machine-indicating) and polarity (inverted-risk: high is a machine signal), and report a likelihood with evidence and explicit uncertainty. A single dimension never decides; the result is a heuristic signal, not proof.`;

/** One turn's score on one dimension, already normalized to 0..1. */
export interface BotTurnScore {
  index: number;
  score: number;
  confidence: number;
}

/** Aggregated scores for one dimension across a transcript's turns. */
export interface BotDimensionSummary {
  id: string;
  label: string;
  category: string;
  group: BotGroup;
  polarity: "inverted-risk";
  direction: string;
  basis: EvidenceBasis;
  weight: number;
  note?: string;
  /** Mean normalized score across scored turns (0..1). */
  score: number;
  /** Population standard deviation of normalized scores (0..1). */
  stddev: number;
  /** Mean TypeSafe confidence across scored turns (0..1). */
  confidence: number;
  /** Number of turns actually scored for this dimension. */
  n: number;
  /** True when enough turns were scored to treat the aggregate as stable. */
  stable: boolean;
  /** Representative excerpts backing the score. */
  evidence: BotEvidenceExcerpt[];
  messages: BotTurnScore[];
}

/** A short, PII-scrubbed quoted excerpt that supports a dimension's score. */
export interface BotEvidenceExcerpt {
  /** 1-based turn index the excerpt is quoted from. */
  index: number;
  /** Short quoted excerpt (≤ 140 chars), direct identifiers scrubbed. */
  excerpt: string;
}

/** Result of scoring one turn: a score and confidence per bot dimension. */
export interface BotTurnEvaluation {
  /** Dimension id -> normalized score (0..1). */
  scores: Record<string, number>;
  /** Dimension id -> TypeSafe confidence (0..1). */
  confidence: Record<string, number>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Something that scores a single turn's `state` across all bot dimensions. */
export interface BotEvaluator {
  evaluateBotTurn(state: Record<string, JsonValue>): Promise<BotTurnEvaluation>;
}

/** A three-way reading of the composite machine likelihood. */
export type BotVerdict = "likely-human" | "inconclusive" | "likely-machine";

/** A complete bot-detection report for one transcript. */
export interface BotDetectionReport {
  /** Input label as given. */
  source: string;
  /** Total turns parsed from the transcript. */
  turnCount: number;
  /** Turns actually sent to the evaluator (after --limit). */
  scoredCount: number;
  generatedAt: string;
  /** Composite weighted machine likelihood (0..1). */
  likelihood: number;
  /** Three-way reading of the likelihood. */
  verdict: BotVerdict;
  dimensions: BotDimensionSummary[];
  usage: { input_tokens: number; output_tokens: number };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Pick the highest-scoring turn per dimension as its machine-signal evidence. */
function buildBotEvidence(
  perTurn: readonly BotTurnScore[],
  contentByIndex: ReadonlyMap<number, string>,
): BotEvidenceExcerpt[] {
  if (perTurn.length === 0) return [];
  const top = [...perTurn].sort((a, b) => b.score - a.score)[0]!;
  const content = contentByIndex.get(top.index);
  if (!content) return [];
  return [{ index: top.index, excerpt: excerptOf(content) }];
}

/**
 * Fold per-turn scores into one bot-detection report: each dimension's value is
 * the mean normalized score across scored turns, and the composite likelihood
 * is the weight-normalized mean of dimension scores.
 *
 * @param source - input label.
 * @param turns - one entry per parsed turn.
 * @param evaluated - one entry per turn in `turns`, null when that turn failed.
 * @param usage - total token usage across scored turns.
 */
export function aggregateBotReport(
  source: string,
  turns: readonly ParsedMessage[],
  evaluated: readonly (BotTurnEvaluation | null)[],
  usage: { input_tokens: number; output_tokens: number },
): BotDetectionReport {
  const contentByIndex = new Map<number, string>();
  for (const turn of turns) contentByIndex.set(turn.index, turn.content);

  const dimensions: BotDimensionSummary[] = BOT_DIMENSIONS.map((dimension) => {
    const perTurn: BotTurnScore[] = [];
    for (let i = 0; i < evaluated.length; i++) {
      const result = evaluated[i];
      const turn = turns[i]!;
      if (!result || !(dimension.id in result.scores)) continue;
      perTurn.push({
        index: turn.index,
        score: result.scores[dimension.id]!,
        confidence: result.confidence[dimension.id]!,
      });
    }

    const n = perTurn.length;
    let sum = 0;
    let confidenceSum = 0;
    for (const entry of perTurn) {
      sum += entry.score;
      confidenceSum += entry.confidence;
    }
    const mean = n === 0 ? 0 : sum / n;
    const variance =
      n === 0 ? 0 : perTurn.reduce((acc, entry) => acc + (entry.score - mean) ** 2, 0) / n;

    return {
      id: dimension.id,
      label: dimension.label,
      category: dimension.category,
      group: dimension.group,
      polarity: dimension.polarity,
      direction: dimension.direction,
      basis: dimension.basis,
      weight: dimension.weight,
      note: dimension.note,
      score: round3(mean),
      stddev: round3(Math.sqrt(variance)),
      confidence: round3(n === 0 ? 0 : confidenceSum / n),
      n,
      stable: n >= MIN_STABLE_TURNS,
      evidence: buildBotEvidence(perTurn, contentByIndex),
      messages: perTurn,
    };
  });

  const weightSum = BOT_DIMENSIONS.reduce((acc, dimension) => acc + dimension.weight, 0);
  const weightedSum = dimensions.reduce((acc, dimension) => acc + dimension.score * dimension.weight, 0);
  const likelihood = weightSum === 0 ? 0 : round3(weightedSum / weightSum);

  return {
    source,
    turnCount: turns.length,
    scoredCount: evaluated.filter((entry) => entry !== null).length,
    generatedAt: new Date().toISOString(),
    likelihood,
    verdict: verdictFor(likelihood),
    dimensions,
    usage,
  };
}

/** Map a composite likelihood to a three-way reading. */
export function verdictFor(likelihood: number): BotVerdict {
  if (likelihood < 0.35) return "likely-human";
  if (likelihood > 0.65) return "likely-machine";
  return "inconclusive";
}

const BOT_DIMENSION_IDS: ReadonlySet<string> = new Set(BOT_DIMENSIONS.map((dimension) => dimension.id));
const BOT_GROUP_IDS: ReadonlySet<BotGroup> = new Set(BOT_GROUP_ORDER.map((group) => group.id));
const BOT_VERDICTS: ReadonlySet<BotVerdict> = new Set(["likely-human", "inconclusive", "likely-machine"]);
const EXCERPT_MAX = 140;

function fail(message: string): never {
  throw new Error(`Bot-detection validation failed: ${message}`);
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate a bot-detection report against the fixed schema and reject (throw)
 * any record that fails it: dimension enum, 0..1 range, direction presence,
 * weight range, required evidence, and a known verdict are all enforced.
 */
export function validateBotReport(report: BotDetectionReport): void {
  if (!Number.isInteger(report.turnCount) || report.turnCount < 0) {
    fail(`invalid turnCount ${report.turnCount}`);
  }
  if (!Number.isInteger(report.scoredCount) || report.scoredCount < 0 || report.scoredCount > report.turnCount) {
    fail(`invalid scoredCount ${report.scoredCount}`);
  }
  if (!inUnit(report.likelihood)) fail(`likelihood ${report.likelihood} is outside 0..1`);
  if (!BOT_VERDICTS.has(report.verdict)) fail(`invalid verdict "${String(report.verdict)}"`);
  if (report.dimensions.length !== BOT_DIMENSIONS.length) {
    fail(`expected ${BOT_DIMENSIONS.length} dimensions, got ${report.dimensions.length}`);
  }
  for (const dimension of report.dimensions) {
    if (!BOT_DIMENSION_IDS.has(dimension.id)) fail(`unknown dimension "${dimension.id}"`);
    if (!BOT_GROUP_IDS.has(dimension.group)) fail(`dimension "${dimension.id}" has invalid group "${String(dimension.group)}"`);
    if (dimension.polarity !== "inverted-risk") fail(`dimension "${dimension.id}" must be inverted-risk`);
    if (typeof dimension.direction !== "string" || dimension.direction.trim() === "") {
      fail(`dimension "${dimension.id}" is missing its direction`);
    }
    if (!Number.isFinite(dimension.weight) || dimension.weight <= 0 || dimension.weight > 1) {
      fail(`dimension "${dimension.id}" weight ${dimension.weight} is outside (0..1]`);
    }
    if (!inUnit(dimension.score)) fail(`dimension "${dimension.id}" score ${dimension.score} is outside 0..1`);
    if (!inUnit(dimension.stddev)) fail(`dimension "${dimension.id}" stddev ${dimension.stddev} is outside 0..1`);
    if (!inUnit(dimension.confidence)) fail(`dimension "${dimension.id}" confidence ${dimension.confidence} is outside 0..1`);
    if (!Number.isInteger(dimension.n) || dimension.n < 0 || dimension.n > report.turnCount) {
      fail(`dimension "${dimension.id}" has invalid n ${dimension.n}`);
    }
    if (dimension.messages.length !== dimension.n) {
      fail(`dimension "${dimension.id}" per-turn count ${dimension.messages.length} does not match n ${dimension.n}`);
    }
    for (const message of dimension.messages) {
      if (!inUnit(message.score)) fail(`dimension "${dimension.id}" has a per-turn score outside 0..1`);
      if (!inUnit(message.confidence)) fail(`dimension "${dimension.id}" has a per-turn confidence outside 0..1`);
    }
    for (const item of dimension.evidence) {
      if (!Number.isInteger(item.index) || item.index < 1 || item.index > report.turnCount) {
        fail(`dimension "${dimension.id}" evidence index ${item.index} is out of range 1..${report.turnCount}`);
      }
      if (typeof item.excerpt !== "string" || item.excerpt.length === 0) {
        fail(`dimension "${dimension.id}" evidence is missing its excerpt`);
      }
      if (item.excerpt.length > EXCERPT_MAX) {
        fail(`dimension "${dimension.id}" evidence excerpt exceeds ${EXCERPT_MAX} chars`);
      }
    }
  }
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/** Short qualitative reading of a machine-indicating dimension's mean score. */
function reading(dimension: BotDimensionSummary): string {
  const score = dimension.score;
  if (score >= 0.6) return "machine signal";
  if (score >= 0.4) return "ambiguous";
  return "human signal";
}

function isElevated(dimension: BotDimensionSummary): boolean {
  return dimension.score >= 0.6;
}

function annotation(dimension: BotDimensionSummary): string {
  const parts: string[] = [];
  if (dimension.n === 0) parts.push("no data");
  if (dimension.n > 0 && !dimension.stable) parts.push("low sample");
  if (dimension.confidence > 0 && dimension.confidence < 0.5) parts.push("low confidence");
  return parts.length === 0 ? "" : ` ${parts.join(", ")}`;
}

function verdictBanner(report: BotDetectionReport): string {
  const labels: Record<BotVerdict, string> = {
    "likely-human": "Likely human",
    inconclusive: "Inconclusive",
    "likely-machine": "Likely machine",
  };
  return `${labels[report.verdict]} (composite machine likelihood ${fmt(report.likelihood)}).`;
}

function summaryTable(report: BotDetectionReport): string {
  const lines = [
    "| Category | Dimension | Weight | Score | n | Confidence | Reading |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const category of BOT_CATEGORIES) {
    for (const dimension of report.dimensions) {
      if (dimension.category !== category) continue;
      lines.push(
        `| ${category} | ${dimension.label} | ${fmt(dimension.weight)} | ${fmt(dimension.score)} | ${dimension.n} | ${fmt(dimension.confidence)} | ${reading(dimension)} |`,
      );
    }
  }
  return lines.join("\n");
}

function detailSections(report: BotDetectionReport): string {
  const sections: string[] = [];
  for (const category of BOT_CATEGORIES) {
    const dimensions = report.dimensions.filter((dimension) => dimension.category === category);
    if (dimensions.length === 0) continue;
    sections.push(
      `### ${category}`,
      "",
      "| Dimension | Direction | Score | StdDev | n | Confidence | Reading |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const dimension of dimensions) {
      sections.push(
        `| ${dimension.label} | ${dimension.direction} | ${fmt(dimension.score)} | ${fmt(dimension.stddev)} | ${dimension.n} | ${fmt(dimension.confidence)} | ${reading(dimension)}${annotation(dimension)} |`,
      );
    }
    sections.push("");
  }
  return sections.join("\n");
}

function evidenceSection(report: BotDetectionReport): string {
  const entries = report.dimensions
    .filter((dimension) => dimension.evidence.length > 0)
    .map((dimension) => {
      const quotes = dimension.evidence.map((item) => `"${item.excerpt}"`).join(" · ");
      return `- **${dimension.label}**: ${quotes}`;
    });
  if (entries.length === 0) return "None (no turns were scored).";
  return entries.join("\n");
}

function flaggedSection(report: BotDetectionReport): string {
  const flagged = report.dimensions.filter((dimension) => isElevated(dimension));
  if (flagged.length === 0) return "None.";
  return flagged
    .map(
      (dimension) =>
        `- **${dimension.label}** (${dimension.category}): score ${fmt(dimension.score)}, weight ${fmt(dimension.weight)} ⚠ machine signal${annotation(dimension)}`,
    )
    .join("\n");
}

function interviewGuide(report: BotDetectionReport): string {
  const sections: string[] = [];
  for (const category of BOT_CATEGORIES) {
    const dimensions = report.dimensions.filter((dimension) => dimension.category === category);
    if (dimensions.length === 0) continue;
    sections.push(`### ${category}`);
    for (const dimension of dimensions) {
      const def = BOT_DIMENSIONS.find((item) => item.id === dimension.id);
      if (!def) continue;
      sections.push(`- **${dimension.label}**: ${def.probes.join(" ")}`);
    }
    sections.push("");
  }
  return sections.join("\n");
}

function caveats(report: BotDetectionReport): string {
  const lines = [
    "Scores are per-dimension means (0–1) of TypeSafe judgments over individual turns; the composite likelihood is a weight-normalized mean of those dimensions. This is an analogue battery — it probes constructs (sycophancy, machine-prior leakage, instruction obedience) that differ between humans and language models, not constructs from human psychometrics. It is a heuristic, adversarial signal, never a proof or a diagnosis.",
    "",
    "Every dimension records a monotonic direction (a high score always means \"more machine-indicating\"), polarity (`inverted-risk`: high is a machine signal, flagged when elevated), basis, and a decisiveness weight. Dimensions are weighted: strong signals (sycophancy, instruction obedience, machine-prior leakage, self-model consistency) outweigh weak ones (prose machinery, human noise).",
    "",
    "A single dimension never decides; the composite is inconclusive in the middle band. A sophisticated actor can fake any of these signals, and a human can trip some of them. Do not use this as a decision about a person or system's identity.",
  ];
  const noted = report.dimensions.filter((dimension) => dimension.note);
  if (noted.length > 0) {
    lines.push("", "Dimension-specific caveats:", ...noted.map((dimension) => `- **${dimension.label}**: ${dimension.note!}`));
  }
  return lines.join("\n");
}

/** Render a bot-detection report as Markdown. */
export function renderBotMarkdown(report: BotDetectionReport): string {
  const lines = [
    `# Bot-Detection Assessment: ${report.source}`,
    "",
    `Generated by \`typesafe-profiler --detect\` on ${report.generatedAt} from ${report.scoredCount} of ${report.turnCount} turns (${report.dimensions.length} analogue dimensions).`,
    "",
    `**Verdict: ${verdictBanner(report)}**`,
    "",
    "**Heuristic analogue battery — not proof of identity, not a human clinical assessment.**",
    "",
    "## Summary",
    "",
    summaryTable(report),
    "",
    "## Details",
    "",
    detailSections(report),
    "## Evidence (highest-scoring turn per dimension)",
    "",
    evidenceSection(report),
    "",
    "## Flagged (elevated machine signals)",
    "",
    flaggedSection(report),
    "",
    "## Interview guide (probes)",
    "",
    interviewGuide(report),
    "## Caveats",
    "",
    caveats(report),
    "",
  ];
  return lines.join("\n");
}

/** Render a bot-detection report as JSON. */
export function renderBotJson(report: BotDetectionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** One dimension's test items, exposed so the interviewer can continue the session. */
export interface BotProbe {
  dimension: string;
  label: string;
  items: readonly string[];
}

/** The full probe battery as a list of dimension-to-test-items entries. */
export function botProbes(): readonly BotProbe[] {
  return BOT_DIMENSIONS.map((dimension) => ({
    dimension: dimension.id,
    label: dimension.label,
    items: dimension.probes,
  }));
}

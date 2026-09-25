import { DIMENSIONS, GROUP_ORDER } from "./dimensions.js";
import type {
  DimensionSummary,
  EvidenceBasis,
  Group,
  Polarity,
  Profile,
} from "./types.js";

/** Maximum length of a stored evidence excerpt, mirrored in the excerpt builder. */
const EXCERPT_MAX = 140;

const DIMENSION_IDS: ReadonlySet<string> = new Set(DIMENSIONS.map((dimension) => dimension.id));
const GROUP_IDS: ReadonlySet<Group> = new Set(GROUP_ORDER.map((group) => group.id));
const POLARITIES: ReadonlySet<Polarity> = new Set(["desirable", "diagnostic", "inverted-risk"]);
const BASES: ReadonlySet<EvidenceBasis> = new Set(["text", "metadata", "self-report"]);

function fail(message: string): never {
  throw new Error(`Profile validation failed: ${message}`);
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate one dimension summary; throws on the first violation. */
function validateDimension(dimension: DimensionSummary, messageCount: number): void {
  const id = dimension.id;
  if (!DIMENSION_IDS.has(id)) fail(`unknown dimension "${id}"`);
  if (!GROUP_IDS.has(dimension.group)) fail(`dimension "${id}" has invalid group "${String(dimension.group)}"`);
  if (!POLARITIES.has(dimension.polarity)) fail(`dimension "${id}" has invalid polarity "${String(dimension.polarity)}"`);
  if (!BASES.has(dimension.basis)) fail(`dimension "${id}" has invalid basis "${String(dimension.basis)}"`);
  if (typeof dimension.direction !== "string" || dimension.direction.trim() === "") {
    fail(`dimension "${id}" is missing its direction`);
  }
  if (!inUnit(dimension.score)) fail(`dimension "${id}" score ${dimension.score} is outside 0..1`);
  if (!inUnit(dimension.stddev)) fail(`dimension "${id}" stddev ${dimension.stddev} is outside 0..1`);
  if (!inUnit(dimension.confidence)) fail(`dimension "${id}" confidence ${dimension.confidence} is outside 0..1`);
  if (!Number.isInteger(dimension.n) || dimension.n < 0 || dimension.n > messageCount) {
    fail(`dimension "${id}" has invalid n ${dimension.n}`);
  }
  if (dimension.messages.length !== dimension.n) {
    fail(`dimension "${id}" per-message count ${dimension.messages.length} does not match n ${dimension.n}`);
  }
  for (const message of dimension.messages) {
    if (!inUnit(message.score)) fail(`dimension "${id}" has a per-message score outside 0..1`);
    if (!inUnit(message.confidence)) fail(`dimension "${id}" has a per-message confidence outside 0..1`);
  }
  // Required evidence: every scored dimension must carry at least one excerpt,
  // except the privacy-sensitive self-disclosure dimension.
  if (id !== "self_disclosure" && dimension.n > 0 && dimension.evidence.length === 0) {
    fail(`dimension "${id}" has ${dimension.n} scored message(s) but no evidence`);
  }
  for (const item of dimension.evidence) {
    if (!Number.isInteger(item.index) || item.index < 1 || item.index > messageCount) {
      fail(`dimension "${id}" evidence index ${item.index} is out of range 1..${messageCount}`);
    }
    if (typeof item.excerpt !== "string" || item.excerpt.length === 0) {
      fail(`dimension "${id}" evidence is missing its excerpt`);
    }
    if (item.excerpt.length > EXCERPT_MAX) {
      fail(`dimension "${id}" evidence excerpt exceeds ${EXCERPT_MAX} chars`);
    }
  }
}

/**
 * Validate a full profile against the fixed schema and reject (throw) any
 * record that fails it: the dimension enum, 0..1 range, polarity and basis
 * enums, direction presence, and required evidence are all enforced.
 */
export function validateProfile(profile: Profile): void {
  if (!Number.isInteger(profile.messageCount) || profile.messageCount < 0) {
    fail(`invalid messageCount ${profile.messageCount}`);
  }
  if (!Number.isInteger(profile.scoredCount) || profile.scoredCount < 0 || profile.scoredCount > profile.messageCount) {
    fail(`invalid scoredCount ${profile.scoredCount}`);
  }
  if (profile.dimensions.length !== DIMENSIONS.length) {
    fail(`expected ${DIMENSIONS.length} dimensions, got ${profile.dimensions.length}`);
  }
  for (const dimension of profile.dimensions) {
    validateDimension(dimension, profile.messageCount);
  }
}

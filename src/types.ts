/** A JSON-compatible value, mirroring what the TypeSafe `state` accepts. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A parsed chat message from one input log file. */
export interface ParsedMessage {
  /** 1-based position of the message within the file. */
  index: number;
  /** Detected author, or null when the log carries no author. */
  author: string | null;
  /** Raw timestamp string, or null when the log carries no timestamps. */
  timestamp: string | null;
  /** Channel name, or null when the log carries no channel. */
  channel: string | null;
  /** The message body text. */
  content: string;
}

/** Whether a high score is desirable, diagnostic, or a warning signal. */
export type Polarity = "desirable" | "diagnostic" | "inverted-risk";

/** Stable machine id for the seven dimension groups. */
export type Group =
  | "communication-style"
  | "cognitive-style"
  | "personality-big-five"
  | "motivation-values"
  | "affective-emotional"
  | "domain-aptitude"
  | "interaction-behavioral";

/** What a score was inferred from. */
export type EvidenceBasis = "text" | "metadata" | "self-report";

/** Five ordered rubric levels, lowest (0) to highest (4), normalized to 0..1 as score/4. */
export type Rubric = readonly [string, string, string, string, string];

/** One scoring dimension. */
export interface Dimension {
  /** Snake-case key used for the TypeSafe question and its answer. */
  id: string;
  /** Human-readable category label, used for report section headers. */
  category: string;
  /** Stable machine id for the group this dimension belongs to. */
  group: Group;
  label: string;
  polarity: Polarity;
  /** Monotonic direction: a high score always means "more of" this trait. */
  direction: string;
  /** What the score is inferred from. */
  basis: EvidenceBasis;
  /** The question TypeSafe answers for this dimension. */
  instructions: string;
  /** Ordered level descriptions, low end (0) to high end (4). */
  rubric: Rubric;
  /** Caveat, e.g. weak when inferred from a single message. */
  note?: string;
}

/** A short, PII-scrubbed quoted excerpt that supports a dimension's score. */
export interface EvidenceExcerpt {
  /** 1-based message index the excerpt is quoted from. */
  index: number;
  /** Short quoted excerpt (≤ 140 chars), direct identifiers scrubbed. */
  excerpt: string;
}

/** One message's score on one dimension, already normalized to 0..1. */
export interface PerMessageScore {
  index: number;
  score: number;
  confidence: number;
}

/** Aggregated scores for one dimension across a user's messages. */
export interface DimensionSummary {
  id: string;
  label: string;
  category: string;
  group: Group;
  polarity: Polarity;
  direction: string;
  basis: EvidenceBasis;
  note?: string;
  /** Mean normalized score across scored messages (0..1). */
  score: number;
  /** Population standard deviation of normalized scores (0..1). */
  stddev: number;
  /** Mean TypeSafe confidence across scored messages (0..1). */
  confidence: number;
  /** Number of messages actually scored for this dimension. */
  n: number;
  /** True when enough messages were scored to treat the aggregate as stable. */
  stable: boolean;
  /** Representative excerpts backing the score (empty for self-disclosure). */
  evidence: EvidenceExcerpt[];
  messages: PerMessageScore[];
}

/** Result of scoring one message: a score and confidence per dimension. */
export interface EvaluatedMessage {
  /** Dimension id -> normalized score (0..1). */
  scores: Record<string, number>;
  /** Dimension id -> TypeSafe confidence (0..1). */
  confidence: Record<string, number>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Something that scores a single message's `state` across all dimensions. */
export interface Evaluator {
  evaluate(state: Record<string, JsonValue>): Promise<EvaluatedMessage>;
}

/** A complete profile for one input file (one user). */
export interface Profile {
  /** Input file path as given. */
  source: string;
  author: string | null;
  /** Total messages parsed from the file. */
  messageCount: number;
  /** Messages actually sent to the evaluator (after --limit). */
  scoredCount: number;
  generatedAt: string;
  dimensions: DimensionSummary[];
  usage: { input_tokens: number; output_tokens: number };
}

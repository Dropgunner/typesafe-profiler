import { score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Questions, ScoreQuestion } from "@typesafe-ai/sdk";
import { BOT_DIMENSIONS, BOT_RUBRIC_MAX } from "./botdetect.js";
import type { BotEvaluator, BotTurnEvaluation } from "./botdetect.js";
import { DIMENSIONS, RUBRIC_MAX } from "./dimensions.js";
import { GUARD_SAFETY_QUESTIONS, GUARD_SEVERITY_MAX } from "./guard.js";
import type { GuardEvaluatedMessage, GuardEvaluator } from "./guard.js";
import type { EvaluatedMessage, Evaluator, JsonValue } from "./types.js";

/** All dimensions as TypeSafe `score` questions, built once and reused. */
export const QUESTIONS: Record<string, ScoreQuestion> = {};
for (const dimension of DIMENSIONS) {
  QUESTIONS[dimension.id] = score(dimension.instructions, dimension.rubric);
}

/** All bot-detection dimensions as TypeSafe `score` questions, built once and reused. */
export const BOT_QUESTIONS: Record<string, ScoreQuestion> = {};
for (const dimension of BOT_DIMENSIONS) {
  BOT_QUESTIONS[dimension.id] = score(dimension.instructions, dimension.rubric);
}

/** The profile dimensions plus the self-harm and severity safety battery, built once. */
export const GUARD_QUESTIONS: Questions = { ...QUESTIONS, ...GUARD_SAFETY_QUESTIONS };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Evaluates messages by calling the TypeSafe API. */
export class TypeSafeEvaluator implements Evaluator {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error("Missing API key.");
    this.model = options.model ?? "jev-latest";
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.model,
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  async evaluate(state: Record<string, JsonValue>): Promise<EvaluatedMessage> {
    // `model` is passed explicitly so the wire body is exactly
    // `{ state, questions, model }`, the same object `requestBody()` dumps.
    const response = await this.client.systemOne({ state, questions: QUESTIONS, model: this.model });
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of DIMENSIONS) {
      const answer = response.answers[dimension.id];
      if (!answer) throw new Error(`TypeSafe returned no answer for ${dimension.id}.`);
      if (answer.type !== "score") {
        throw new Error(`TypeSafe returned "${answer.type}" for ${dimension.id}, expected "score".`);
      }
      scores[dimension.id] = clamp01(answer.score / RUBRIC_MAX);
      confidence[dimension.id] = clamp01(answer.confidence);
    }
    return {
      scores,
      confidence,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

/** Evaluates turns by calling the TypeSafe API across the bot-detection battery. */
export class BotTypeSafeEvaluator implements BotEvaluator {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error("Missing API key.");
    this.model = options.model ?? "jev-latest";
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.model,
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  async evaluateBotTurn(state: Record<string, JsonValue>): Promise<BotTurnEvaluation> {
    const response = await this.client.systemOne({ state, questions: BOT_QUESTIONS, model: this.model });
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of BOT_DIMENSIONS) {
      const answer = response.answers[dimension.id];
      if (!answer) throw new Error(`TypeSafe returned no answer for ${dimension.id}.`);
      if (answer.type !== "score") {
        throw new Error(`TypeSafe returned "${answer.type}" for ${dimension.id}, expected "score".`);
      }
      scores[dimension.id] = clamp01(answer.score / BOT_RUBRIC_MAX);
      confidence[dimension.id] = clamp01(answer.confidence);
    }
    return {
      scores,
      confidence,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

/** Evaluates messages by calling the TypeSafe API across the profile dimensions plus the safety battery. */
export class GuardTypeSafeEvaluator implements GuardEvaluator {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: { apiKey: string; model?: string; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error("Missing API key.");
    this.model = options.model ?? "jev-latest";
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: this.model,
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  async evaluateGuard(state: Record<string, JsonValue>): Promise<GuardEvaluatedMessage> {
    const response = await this.client.systemOne({ state, questions: GUARD_QUESTIONS, model: this.model });
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of DIMENSIONS) {
      const answer = response.answers[dimension.id];
      if (!answer) throw new Error(`TypeSafe returned no answer for ${dimension.id}.`);
      if (answer.type !== "score") {
        throw new Error(`TypeSafe returned "${answer.type}" for ${dimension.id}, expected "score".`);
      }
      scores[dimension.id] = clamp01(answer.score / RUBRIC_MAX);
      confidence[dimension.id] = clamp01(answer.confidence);
    }
    const selfHarm = response.answers["self_harm"];
    if (!selfHarm || selfHarm.type !== "noul") throw new Error("TypeSafe returned no self-harm answer.");
    const severity = response.answers["severity"];
    if (!severity || severity.type !== "score") throw new Error("TypeSafe returned no severity answer.");
    return {
      scores,
      confidence,
      selfHarm: clamp01(selfHarm.noul),
      severity: clamp01(severity.score / GUARD_SEVERITY_MAX),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

/** 32-bit FNV-1a hash, used only to make the dry-run deterministic. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Evaluates messages with deterministic fake scores; no API key required. */
export class DryRunEvaluator implements Evaluator {
  async evaluate(state: Record<string, JsonValue>): Promise<EvaluatedMessage> {
    const content = String(state["content"] ?? "");
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of DIMENSIONS) {
      const hash = fnv1a(`${dimension.id}\u0000${content}`);
      scores[dimension.id] = (hash % 1000) / 1000;
      confidence[dimension.id] = 0.5 + ((hash >>> 5) % 500) / 1000;
    }
    return {
      scores,
      confidence,
      usage: { input_tokens: content.length, output_tokens: DIMENSIONS.length },
    };
  }
}

/** Evaluates turns with deterministic fake scores across the bot-detection battery; no API key required. */
export class BotDryRunEvaluator implements BotEvaluator {
  async evaluateBotTurn(state: Record<string, JsonValue>): Promise<BotTurnEvaluation> {
    const content = String(state["content"] ?? "");
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of BOT_DIMENSIONS) {
      const hash = fnv1a(`${dimension.id}\u0000${content}`);
      scores[dimension.id] = (hash % 1000) / 1000;
      confidence[dimension.id] = 0.5 + ((hash >>> 5) % 500) / 1000;
    }
    return {
      scores,
      confidence,
      usage: { input_tokens: content.length, output_tokens: BOT_DIMENSIONS.length },
    };
  }
}

/** Evaluates messages with deterministic fake scores across the profile dimensions plus the safety battery; no API key required. */
export class GuardDryRunEvaluator implements GuardEvaluator {
  async evaluateGuard(state: Record<string, JsonValue>): Promise<GuardEvaluatedMessage> {
    const content = String(state["content"] ?? "");
    const scores: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    for (const dimension of DIMENSIONS) {
      const hash = fnv1a(`${dimension.id}\u0000${content}`);
      scores[dimension.id] = (hash % 1000) / 1000;
      confidence[dimension.id] = 0.5 + ((hash >>> 5) % 500) / 1000;
    }
    return {
      scores,
      confidence,
      selfHarm: (fnv1a(`self_harm\u0000${content}`) % 1000) / 1000,
      severity: (fnv1a(`severity\u0000${content}`) % 1000) / 1000,
      usage: { input_tokens: content.length, output_tokens: DIMENSIONS.length + 2 },
    };
  }
}

/** Run `fn` over `items` with at most `limit` calls in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

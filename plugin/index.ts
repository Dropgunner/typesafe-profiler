/**
 * TypeSafe tools for a local Harness profile: classification, rubric scoring,
 * psychological profiling (single-message and full-log), a Jev yes/no gate,
 * output pruning, transcript compaction, and bounded next-token generation.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypeSafeClient, APIError, score, noul, choice, type Questions, type ScoreQuestion } from '@typesafe-ai/sdk'
import { BOT_DIMENSIONS, BOT_RUBRIC_MAX, aggregateBotReport, validateBotReport, renderBotMarkdown, botProbes } from '../src/botdetect.js'
import type { BotDetectionReport, BotDimensionSummary, BotTurnEvaluation } from '../src/botdetect.js'
import { DIMENSIONS, RUBRIC_MAX } from '../src/dimensions.js'
import { parseChatLog, buildState } from '../src/parse.js'
import { aggregate } from '../src/aggregate.js'
import { validateProfile } from '../src/schema.js'
import { renderMarkdown } from '../src/report.js'
import {
  DEFAULT_GUARD_POLICY,
  GUARD_POLICIES,
  GUARD_SAFETY_QUESTIONS,
  GUARD_SEVERITY_MAX,
  MESSAGE_BATTERIES,
  MESSAGE_HAZARD_ACTION,
  MESSAGE_HAZARDS,
  guardProfile,
  hazardTriggered,
  renderGuardMarkdown,
  route,
  validateGuardReport,
} from '../src/guard.js'
import type { GuardEvaluatedMessage, MessageSide } from '../src/guard.js'
import { normalizePattern, buildPatternReport, validatePatternReport, renderPatternMarkdown } from '../src/patterns.js'
import type { PatternInput, PatternKind } from '../src/patterns.js'
import type { DimensionSummary, EvaluatedMessage, JsonValue, Profile } from '../src/types.js'

/** Loader identity. */
export const name = 'typesafe-profiler'
/** Required Harness services. */
export const inject = ['tools']
/** Deployment limits; credentials are read only from the host environment. */
export interface Config {
  model: string
  timeoutMs: number
  maxInputBytes: number
  maxCriteria: number
  profileLimit: number
  profileConcurrency: number
}
/** Validate deployment settings before tools become available. */
export const Config: Schema<Config> = Schema.object({
  model: Schema.string().default('jev-latest'),
  timeoutMs: Schema.number().min(1).max(300000).step(1).default(30000),
  maxInputBytes: Schema.number().min(1).step(1).default(65536),
  maxCriteria: Schema.number().min(2).max(100).step(1).default(20),
  profileLimit: Schema.number().min(1).max(500).step(1).default(200),
  profileConcurrency: Schema.number().min(1).max(32).step(1).default(4),
})

// Algorithm constants (behavior, not deployment tunables).
const PRUNE_MAX_CHUNKS = 200
const PRUNE_MAX_LINE_CHARS = 2000
const PRUNE_KEEP_THRESHOLD = 0.5
const COMPACT_PRESERVE_RECENT = 6
const COMPACT_KEEP_THRESHOLD = 0.5
const COMPACT_STATE_TEXT_CHARS = 1000
const COMPACT_TRUNCATE_HEAD_CHARS = 300
const GENERATE_DEFAULT_TOKENS = 10
const GENERATE_MAX_TOKENS_CAP = 50
const PATTERN_MATCH_MAX_MESSAGES = 2000

const usageSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    input_tokens: { type: 'integer', required: true },
    output_tokens: { type: 'integer', required: true },
  },
} as const
const commonOutput = {
  model: { type: 'string', required: true },
  confidence: { type: 'number', required: true },
  usage: usageSchema,
} as const
const commonInput = {
  text: { type: 'string', required: true, description: 'Text to send to TypeSafe for evaluation. Include only material needed for this task.' },
  instructions: { type: 'string', required: true, description: 'Question or evaluation instructions.' },
} as const

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('TypeSafe returned an invalid response.')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('TypeSafe returned an invalid response.')
  return value
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('TypeSafe returned an invalid response.')
  return value
}
function nonempty(value: string): void {
  if (!value.trim()) throw new Error('Text, instructions, labels, and rubric descriptions must not be empty.')
}
function probabilities(value: unknown, keys: string[]): number[] {
  const record = object(value)
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) throw new Error('TypeSafe returned probabilities for unexpected criteria.')
  return keys.map(key => number(record[key], 0, 1))
}

/** All psychological dimensions as TypeSafe `score` questions, built once. */
const PROFILE_QUESTIONS: Record<string, ScoreQuestion> = {}
for (const dimension of DIMENSIONS) PROFILE_QUESTIONS[dimension.id] = score(dimension.instructions, dimension.rubric)

/** All bot-detection dimensions as TypeSafe `score` questions, built once. */
const BOT_QUESTIONS: Record<string, ScoreQuestion> = {}
for (const dimension of BOT_DIMENSIONS) BOT_QUESTIONS[dimension.id] = score(dimension.instructions, dimension.rubric)

/** The profile dimensions plus the self-harm and severity safety battery, built once. */
const GUARD_PROFILE_QUESTIONS: Questions = { ...PROFILE_QUESTIONS, ...GUARD_SAFETY_QUESTIONS }

/** One dimension without its per-message score array; evidence excerpts already summarize it. */
type SummarizedDimension = Omit<DimensionSummary, 'messages'>
/** A profile whose per-message score arrays are stripped, matching the tool's output schema. */
type SummarizedProfile = Omit<Profile, 'dimensions'> & { dimensions: SummarizedDimension[] }

/** Strip the per-message score arrays so the returned profile stays bounded. */
function summarizeProfile(profile: Profile): SummarizedProfile {
  const plain = JSON.parse(JSON.stringify(profile)) as Profile
  const dimensions = plain.dimensions.map(({ messages: _messages, ...rest }) => rest)
  return { ...plain, dimensions }
}

/** One bot dimension without its per-turn score array; evidence excerpts already summarize it. */
type SummarizedBotDimension = Omit<BotDimensionSummary, 'messages'>
/** A bot report whose per-turn score arrays are stripped, matching the tool's output schema. */
type SummarizedBotReport = Omit<BotDetectionReport, 'dimensions'> & { dimensions: SummarizedBotDimension[] }

/** Strip the per-turn score arrays so the returned assessment stays bounded. */
function summarizeBotReport(report: BotDetectionReport): SummarizedBotReport {
  const plain = JSON.parse(JSON.stringify(report)) as BotDetectionReport
  const dimensions = plain.dimensions.map(({ messages: _messages, ...rest }) => rest)
  return { ...plain, dimensions }
}

/** Run `fn` over `items` with at most `limit` calls in flight, preserving order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** Split over-long lines, then group into chunks of at most `size` lines. */
function chunkLines(text: string, size: number): { text: string; lines: number }[] {
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.length <= PRUNE_MAX_LINE_CHARS) lines.push(line)
    else for (let i = 0; i < line.length; i += PRUNE_MAX_LINE_CHARS) lines.push(line.slice(i, i + PRUNE_MAX_LINE_CHARS))
  }
  const chunks: { text: string; lines: number }[] = []
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size)
    chunks.push({ text: slice.join('\n'), lines: slice.length })
  }
  return chunks
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

/**
 * Register tools with bounded requests, cancellation, and sanitized errors.
 * @param ctx - Harness tool registry context.
 * @param config - Validated model and resource limits.
 */
export function apply(ctx: Context, config: Config): void {
  nonempty(config.model)
  const apiKey = process.env['TYPESAFE_API_KEY']?.trim()
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY in the Harness host environment to enable TypeSafe.')
  const client = new TypeSafeClient({
    apiKey, baseURL: 'https://api.typesafe.ai', defaultModel: config.model,
    timeout: config.timeoutMs, retry: { maxRetries: 0 }, logLevel: 'off',
  })
  const lifecycle = new AbortController()
  const active = new Set<Promise<unknown>>()
  ctx.effect(() => async () => {
    lifecycle.abort()
    await Promise.allSettled([...active])
  })

  async function call(state: string | Record<string, JsonValue>, questions: Questions, signal: AbortSignal) {
    const request = { state, questions, model: config.model }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > config.maxInputBytes) throw new Error(`TypeSafe request exceeds ${config.maxInputBytes} bytes.`)
    const combined = AbortSignal.any([signal, lifecycle.signal])
    combined.throwIfAborted()
    const pending = (async () => {
      let raw: unknown
      try {
        raw = await client.systemOne(request, { signal: combined })
      } catch (error) {
        if (combined.aborted) throw new Error('TypeSafe evaluation cancelled.')
        // API bodies and connection messages may contain supplied text; do not log or render them.
        if (error instanceof APIError) throw new Error(`TypeSafe request failed (HTTP ${error.status}).`)
        throw new Error('TypeSafe request failed or timed out.')
      }
      combined.throwIfAborted()
      const response = object(raw)
      const usage = object(response['usage'])
      const input = number(usage['input_tokens'], 0, Number.MAX_SAFE_INTEGER)
      const output = number(usage['output_tokens'], 0, Number.MAX_SAFE_INTEGER)
      if (!Number.isInteger(input) || !Number.isInteger(output)) throw new Error('TypeSafe returned invalid token usage.')
      return {
        model: text(response['model']),
        usage: { input_tokens: input, output_tokens: output },
        answers: object(response['answers']),
      }
    })()
    active.add(pending)
    try { return await pending } finally { active.delete(pending) }
  }

  async function evaluate(state: string, instructions: string, criteria: string[], question: Questions[string], signal: AbortSignal) {
    nonempty(state)
    nonempty(instructions)
    criteria.forEach(nonempty)
    if (criteria.length < 2 || criteria.length > config.maxCriteria) throw new Error(`Provide 2 to ${config.maxCriteria} criteria.`)
    const { answers, ...metadata } = await call(state, { result: question }, signal)
    return { ...metadata, answer: object(answers['result']) }
  }

  async function evaluateProfile(state: string, signal: AbortSignal) {
    nonempty(state)
    const { answers, ...metadata } = await call(state, PROFILE_QUESTIONS, signal)
    const dimensions = DIMENSIONS.map(dimension => {
      const answer = object(answers[dimension.id])
      if (answer['type'] !== 'score') throw new Error(`TypeSafe returned the wrong answer type for ${dimension.id}.`)
      return {
        id: dimension.id,
        category: dimension.category,
        label: dimension.label,
        polarity: dimension.polarity,
        direction: dimension.direction,
        score: number(answer['score'], 0, RUBRIC_MAX) / RUBRIC_MAX,
        confidence: number(answer['confidence'], 0, 1),
        note: dimension.note ?? '',
      }
    })
    return { ...metadata, dimensions }
  }

  async function evaluateMessage(state: Record<string, JsonValue>, signal: AbortSignal): Promise<EvaluatedMessage> {
    const { answers, usage } = await call(state, PROFILE_QUESTIONS, signal)
    const scores: Record<string, number> = {}
    const confidence: Record<string, number> = {}
    for (const dimension of DIMENSIONS) {
      const answer = object(answers[dimension.id])
      if (answer['type'] !== 'score') throw new Error(`TypeSafe returned the wrong answer type for ${dimension.id}.`)
      scores[dimension.id] = number(answer['score'], 0, RUBRIC_MAX) / RUBRIC_MAX
      confidence[dimension.id] = number(answer['confidence'], 0, 1)
    }
    return { scores, confidence, usage }
  }

  async function evaluateBotTurn(state: Record<string, JsonValue>, signal: AbortSignal): Promise<BotTurnEvaluation> {
    const { answers, usage } = await call(state, BOT_QUESTIONS, signal)
    const scores: Record<string, number> = {}
    const confidence: Record<string, number> = {}
    for (const dimension of BOT_DIMENSIONS) {
      const answer = object(answers[dimension.id])
      if (answer['type'] !== 'score') throw new Error(`TypeSafe returned the wrong answer type for ${dimension.id}.`)
      scores[dimension.id] = number(answer['score'], 0, BOT_RUBRIC_MAX) / BOT_RUBRIC_MAX
      confidence[dimension.id] = number(answer['confidence'], 0, 1)
    }
    return { scores, confidence, usage }
  }

  async function evaluateGuardMessage(state: Record<string, JsonValue>, signal: AbortSignal): Promise<GuardEvaluatedMessage> {
    const { answers, usage } = await call(state, GUARD_PROFILE_QUESTIONS, signal)
    const scores: Record<string, number> = {}
    const confidence: Record<string, number> = {}
    for (const dimension of DIMENSIONS) {
      const answer = object(answers[dimension.id])
      if (answer['type'] !== 'score') throw new Error(`TypeSafe returned the wrong answer type for ${dimension.id}.`)
      scores[dimension.id] = number(answer['score'], 0, RUBRIC_MAX) / RUBRIC_MAX
      confidence[dimension.id] = number(answer['confidence'], 0, 1)
    }
    const selfHarm = object(answers['self_harm'])
    if (selfHarm['type'] !== 'noul') throw new Error('TypeSafe returned the wrong answer type for self_harm.')
    const severity = object(answers['severity'])
    if (severity['type'] !== 'score') throw new Error('TypeSafe returned the wrong answer type for severity.')
    return {
      scores,
      confidence,
      selfHarm: number(selfHarm['noul'], 0, 1),
      severity: number(severity['score'], 0, GUARD_SEVERITY_MAX) / GUARD_SEVERITY_MAX,
      usage,
    }
  }

  ctx.tools.register(defineTool({
    name: 'typesafe_classify',
    description: 'Classify supplied text into one of your labels using TypeSafe. Sends the text and question to the external TypeSafe API. Returns a label and reported probabilities, not a guarantee of correctness.',
    parameters: {
      ...commonInput,
      labels: { type: 'array', items: { type: 'string' }, required: true, description: 'Distinct candidate labels (at least two).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ...commonOutput,
        choice: { type: 'string', required: true },
        probabilities: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          label: { type: 'string', required: true }, probability: { type: 'number', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (new Set(args.labels).size !== args.labels.length) throw new Error('Classification labels must be distinct.')
      const { answer, ...metadata } = await evaluate(args.text, args.instructions, args.labels, {
        type: 'choice', instructions: args.instructions, criteria: Object.fromEntries(args.labels.map(label => [label, null])),
      }, exec.signal)
      if (answer['type'] !== 'choice') throw new Error('TypeSafe returned the wrong answer type.')
      const selected = text(answer['choice'])
      if (!args.labels.includes(selected)) throw new Error('TypeSafe returned an unknown label.')
      const values = probabilities(answer['probabilities'], args.labels)
      return { ...metadata, choice: selected, confidence: number(answer['confidence'], 0, 1), probabilities: args.labels.map((label, i) => ({ label, probability: values[i]! })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'typesafe_score',
    description: 'Score supplied text against an ordered rubric using TypeSafe. Sends the text and rubric to the external TypeSafe API. The expected score may be fractional, from 0 to rubric.length - 1.',
    parameters: {
      ...commonInput,
      rubric: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered descriptions for levels 0, 1, and higher (at least two).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ...commonOutput,
        score: { type: 'number', required: true },
        probabilities: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          level: { type: 'integer', required: true }, description: { type: 'string', required: true }, probability: { type: 'number', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args.rubric.length < 2) throw new Error('Provide at least two rubric levels.')
      const [first, second, ...rest] = args.rubric
      const { answer, ...metadata } = await evaluate(args.text, args.instructions, args.rubric, {
        type: 'score', instructions: args.instructions, criteria: [first!, second!, ...rest],
      }, exec.signal)
      if (answer['type'] !== 'score') throw new Error('TypeSafe returned the wrong answer type.')
      const values = probabilities(answer['probabilities'], args.rubric.map((_, i) => String(i)))
      return { ...metadata, score: number(answer['score'], 0, args.rubric.length - 1), confidence: number(answer['confidence'], 0, 1), probabilities: args.rubric.map((description, level) => ({ level, description, probability: values[level]! })) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'psych_profile',
    description: `Score supplied text across ${DIMENSIONS.length} psychological dimensions (communication, cognitive, personality, motivation, affect, domain aptitude, and interaction) using TypeSafe. Sends the text to the external TypeSafe API in one call. Returns a normalized 0–1 score and confidence per dimension with category, polarity, and direction; a high score always means more of the named trait, and polarity marks whether that is desirable, diagnostic, or a risk. Results are estimates, not a guarantee of correctness.`,
    parameters: {
      text: { type: 'string', required: true, description: 'A single user message or short transcript to profile across the psychological dimensions.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        dimensions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          category: { type: 'string', required: true },
          label: { type: 'string', required: true },
          polarity: { type: 'string', required: true },
          direction: { type: 'string', required: true },
          score: { type: 'number', required: true },
          confidence: { type: 'number', required: true },
          note: { type: 'string', required: true },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const { dimensions, ...metadata } = await evaluateProfile(args.text, exec.signal)
      return { ...metadata, dimensions }
    },
  }))

  const evidenceSchema = { type: 'object', additionalProperties: false, properties: {
    index: { type: 'integer', required: true },
    excerpt: { type: 'string', required: true },
  } } as const
  const profileDimensionSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    category: { type: 'string', required: true },
    group: { type: 'string', required: true },
    polarity: { type: 'string', required: true },
    direction: { type: 'string', required: true },
    basis: { type: 'string', required: true },
    note: { type: 'string' },
    score: { type: 'number', required: true },
    stddev: { type: 'number', required: true },
    confidence: { type: 'number', required: true },
    n: { type: 'integer', required: true },
    stable: { type: 'boolean', required: true },
    evidence: { type: 'array', required: true, items: evidenceSchema },
  } } as const
  const profileSchema = { type: 'object', additionalProperties: false, required: true, properties: {
    source: { type: 'string', required: true },
    author: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    messageCount: { type: 'integer', required: true },
    scoredCount: { type: 'integer', required: true },
    generatedAt: { type: 'string', required: true },
    dimensions: { type: 'array', required: true, items: profileDimensionSchema },
    usage: usageSchema,
  } } as const

  ctx.tools.register(defineTool({
    name: 'typesafe_profile',
    description: `Parse a single user's chat log (auto-detected format: DiscordChatExporter plaintext, copy-paste, Markdown, "Author: text", or raw), score every message across ${DIMENSIONS.length} psychological dimensions, and aggregate them into a stable, schema-validated profile plus a Markdown report. Sends each message to the external TypeSafe API. A high score always means more of the named trait; polarity marks desirable, diagnostic, or inverted-risk. Results are heuristic estimates, not a clinical assessment.`,
    parameters: {
      text: { type: 'string', required: true, description: 'A single user\'s chat log to profile.' },
      source: { type: 'string', description: 'Label used as the report title (defaults to "chat-log").' },
      limit: { type: 'integer', description: 'Maximum messages to score (1 to the configured profile limit).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        profile: profileSchema,
        markdown: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(args, exec) {
      const messages = parseChatLog(args.text)
      if (messages.length === 0) throw new Error('No messages could be parsed from the chat log.')
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > config.profileLimit)) {
        throw new Error(`limit must be an integer between 1 and ${config.profileLimit}.`)
      }
      const limited = messages.slice(0, args.limit ?? config.profileLimit)
      const evaluated = await mapWithConcurrency(limited, config.profileConcurrency, async (message) => {
        try { return await evaluateMessage(buildState(message), exec.signal) }
        catch { return null }
      })
      let inputTokens = 0
      let outputTokens = 0
      for (const result of evaluated) {
        if (!result) continue
        inputTokens += result.usage.input_tokens
        outputTokens += result.usage.output_tokens
      }
      const author = limited.find(message => message.author)?.author ?? null
      const profile = aggregate(args.source ?? 'chat-log', author, limited, evaluated, { input_tokens: inputTokens, output_tokens: outputTokens })
      validateProfile(profile)
      if (profile.scoredCount === 0) throw new Error('No messages were scored; the profile is empty.')
      return { profile: summarizeProfile(profile), markdown: renderMarkdown(profile) }
    },
  }))

  const botEvidenceSchema = { type: 'object', additionalProperties: false, properties: {
    index: { type: 'integer', required: true },
    excerpt: { type: 'string', required: true },
  } } as const
  const botDimensionSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    category: { type: 'string', required: true },
    group: { type: 'string', required: true },
    polarity: { type: 'string', required: true },
    direction: { type: 'string', required: true },
    basis: { type: 'string', required: true },
    weight: { type: 'number', required: true },
    note: { type: 'string' },
    score: { type: 'number', required: true },
    stddev: { type: 'number', required: true },
    confidence: { type: 'number', required: true },
    n: { type: 'integer', required: true },
    stable: { type: 'boolean', required: true },
    evidence: { type: 'array', required: true, items: botEvidenceSchema },
  } } as const
  const botReportSchema = { type: 'object', additionalProperties: false, required: true, properties: {
    source: { type: 'string', required: true },
    turnCount: { type: 'integer', required: true },
    scoredCount: { type: 'integer', required: true },
    generatedAt: { type: 'string', required: true },
    likelihood: { type: 'number', required: true },
    verdict: { type: 'string', required: true },
    dimensions: { type: 'array', required: true, items: botDimensionSchema },
    usage: usageSchema,
  } } as const
  const botProbeSchema = { type: 'object', additionalProperties: false, properties: {
    dimension: { type: 'string', required: true },
    label: { type: 'string', required: true },
    items: { type: 'array', required: true, items: { type: 'string' } },
  } } as const

  ctx.tools.register(defineTool({
    name: 'bot_detect',
    description: `Estimate whether a conversation transcript is human or an automated system using an analogue psychological test battery. Sends each parsed turn to the external TypeSafe API and scores it across ${BOT_DIMENSIONS.length} machine-indicating dimensions (phenomenology, memory and identity, social cognition, linguistic signature, metacognition and limits). A high score always means more machine-indicating; every dimension is inverted-risk and weighted into a composite likelihood with a likely-human / inconclusive / likely-machine verdict. This is a heuristic, adversarial signal, not proof of identity.`,
    parameters: {
      text: { type: 'string', required: true, description: "A transcript of the candidate's turns to assess (already filtered to the candidate; auto-detected message format)." },
      source: { type: 'string', description: 'Label used as the report title (defaults to "transcript").' },
      limit: { type: 'integer', description: 'Maximum turns to score (1 to the configured profile limit).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        report: botReportSchema,
        markdown: { type: 'string', required: true },
        probes: { type: 'array', required: true, items: botProbeSchema },
      } },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(args, exec) {
      const turns = parseChatLog(args.text)
      if (turns.length === 0) throw new Error('No turns could be parsed from the transcript.')
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > config.profileLimit)) {
        throw new Error(`limit must be an integer between 1 and ${config.profileLimit}.`)
      }
      const limited = turns.slice(0, args.limit ?? config.profileLimit)
      const evaluated = await mapWithConcurrency(limited, config.profileConcurrency, async (turn) => {
        try { return await evaluateBotTurn(buildState(turn), exec.signal) }
        catch { return null }
      })
      let inputTokens = 0
      let outputTokens = 0
      for (const result of evaluated) {
        if (!result) continue
        inputTokens += result.usage.input_tokens
        outputTokens += result.usage.output_tokens
      }
      const report = aggregateBotReport(args.source ?? 'transcript', limited, evaluated, { input_tokens: inputTokens, output_tokens: outputTokens })
      validateBotReport(report)
      if (report.scoredCount === 0) throw new Error('No turns were scored; the assessment is empty.')
      const probes = botProbes().map(probe => ({ dimension: probe.dimension, label: probe.label, items: [...probe.items] }))
      return { report: summarizeBotReport(report), markdown: renderBotMarkdown(report), probes }
    },
  }))

  const guardHazardSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    value: { type: 'number', required: true },
    action: { type: 'string', required: true },
    triggered: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  } } as const
  const guardReportSchema = { type: 'object', additionalProperties: false, required: true, properties: {
    source: { type: 'string', required: true },
    policy: { type: 'string', required: true },
    action: { type: 'string', required: true },
    severity: { type: 'number', required: true },
    hazards: { type: 'array', required: true, items: guardHazardSchema },
    flagged: { type: 'array', required: true, items: { type: 'string' } },
    generatedAt: { type: 'string', required: true },
    usage: usageSchema,
  } } as const

  ctx.tools.register(defineTool({
    name: 'guard_profile',
    description: `Parse a single user's chat log, score every message across ${DIMENSIONS.length} psychological dimensions plus a self-harm and severity safety battery, aggregate them, and route the profile to one of pass / review / block / support under a named guard policy. Sends each message to the external TypeSafe API. Mirrors the TypeSafe guardrails structure: the inverted-risk dimensions, a self-harm signal, and low-sample / low-confidence meta-flags feed thresholds in application code, which decide the action. Results are heuristic estimates, not a decision about the person.`,
    parameters: {
      text: { type: 'string', required: true, description: "A single user's chat log to profile and route." },
      source: { type: 'string', description: 'Label used as the report title (defaults to "chat-log").' },
      policy: { type: 'string', description: 'Routing policy: "strict" (default) or "permissive".' },
      limit: { type: 'integer', description: 'Maximum messages to score (1 to the configured profile limit).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        report: guardReportSchema,
        action: { type: 'string', required: true },
        markdown: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(args, exec) {
      const messages = parseChatLog(args.text)
      if (messages.length === 0) throw new Error('No messages could be parsed from the chat log.')
      if (args.policy !== undefined && !(args.policy in GUARD_POLICIES)) {
        throw new Error(`policy must be one of: ${Object.keys(GUARD_POLICIES).join(', ')}.`)
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > config.profileLimit)) {
        throw new Error(`limit must be an integer between 1 and ${config.profileLimit}.`)
      }
      const limited = messages.slice(0, args.limit ?? config.profileLimit)
      const evaluated = await mapWithConcurrency(limited, config.profileConcurrency, async (message) => {
        try { return await evaluateGuardMessage(buildState(message), exec.signal) }
        catch { return null }
      })
      let inputTokens = 0
      let outputTokens = 0
      for (const result of evaluated) {
        if (!result) continue
        inputTokens += result.usage.input_tokens
        outputTokens += result.usage.output_tokens
      }
      const author = limited.find(message => message.author)?.author ?? null
      const profile = aggregate(args.source ?? 'chat-log', author, limited, evaluated, { input_tokens: inputTokens, output_tokens: outputTokens })
      validateProfile(profile)
      if (profile.scoredCount === 0) throw new Error('No messages were scored; the guard report is empty.')
      let selfHarmMax = 0
      let severityMax = 0
      for (const result of evaluated) {
        if (!result) continue
        selfHarmMax = Math.max(selfHarmMax, result.selfHarm)
        severityMax = Math.max(severityMax, result.severity)
      }
      const report = guardProfile(profile, { selfHarm: selfHarmMax, severity: severityMax }, args.policy ?? DEFAULT_GUARD_POLICY, { input_tokens: inputTokens, output_tokens: outputTokens })
      validateGuardReport(report)
      return { report, action: report.action, markdown: renderGuardMarkdown(report) }
    },
  }))

  const guardMessageHazardSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true },
    probability: { type: 'number', required: true },
    action: { type: 'string', required: true },
    triggered: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  } } as const

  ctx.tools.register(defineTool({
    name: 'guard_message',
    description: 'Screen one message going into or out of an LLM with a single TypeSafe request: a battery of yes/no hazard questions (jailbreak or broke-policy, harmful request, medical advice, self-harm) plus a severity score, then route the result to pass / review / block / support under a named policy. Mirrors the TypeSafe guardrails cookbook; run it on both LLM inputs and outputs. Probabilities are estimates, not guarantees.',
    parameters: {
      text: { type: 'string', required: true, description: 'The message to screen.' },
      side: { type: 'string', description: '"input" (a user message) or "output" (the assistant\'s reply); default "input".' },
      policy: { type: 'string', description: 'Routing policy: "strict" (default) or "permissive".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        action: { type: 'string', required: true },
        policy: { type: 'string', required: true },
        severity: { type: 'number', required: true },
        hazards: { type: 'array', required: true, items: guardMessageHazardSchema },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      nonempty(args.text)
      const side: MessageSide = args.side === 'output' ? 'output' : 'input'
      if (args.policy !== undefined && !(args.policy in GUARD_POLICIES)) {
        throw new Error(`policy must be one of: ${Object.keys(GUARD_POLICIES).join(', ')}.`)
      }
      const policy = GUARD_POLICIES[args.policy ?? DEFAULT_GUARD_POLICY]!
      const battery = MESSAGE_BATTERIES[side]
      const { model, usage, answers } = await call(args.text, battery, exec.signal)
      const hazardIds = MESSAGE_HAZARDS[side]
      const probabilities: Record<string, number> = {}
      for (const id of hazardIds) {
        const answer = object(answers[id])
        if (answer['type'] !== 'noul') throw new Error(`TypeSafe returned the wrong answer type for ${id}.`)
        probabilities[id] = number(answer['noul'], 0, 1)
      }
      const severityAnswer = object(answers['severity'])
      if (severityAnswer['type'] !== 'score') throw new Error('TypeSafe returned the wrong answer type for severity.')
      const severity = number(severityAnswer['score'], 0, GUARD_SEVERITY_MAX) / GUARD_SEVERITY_MAX
      const action = route(probabilities, MESSAGE_HAZARD_ACTION, severity, policy)
      const hazardRows: Array<{ id: string; probability: number; action: string; triggered: string | null }> = []
      for (const id of hazardIds) {
        const probability = probabilities[id]!
        const hazardAction = MESSAGE_HAZARD_ACTION[id]!
        hazardRows.push({ id, probability, action: hazardAction, triggered: hazardTriggered(probability, hazardAction, severity, policy) })
      }
      return { model, usage, action, policy: args.policy ?? DEFAULT_GUARD_POLICY, severity, hazards: hazardRows }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'typesafe_noul',
    description: 'Ask TypeSafe a yes/no (noul) question about supplied text and return the probability of a yes answer. Sends the text and question to the external TypeSafe API. Use it as a decision gate; the probability is an estimate, not a guarantee.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to evaluate.' },
      instructions: { type: 'string', required: true, description: 'The yes/no question.' },
      yes: { type: 'string', description: 'Description of the yes outcome.' },
      no: { type: 'string', description: 'Description of the no outcome.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        yes_probability: { type: 'number', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      nonempty(args.text)
      nonempty(args.instructions)
      const { answers, ...metadata } = await call(args.text, { result: noul(args.instructions, { true: args.yes ?? null, false: args.no ?? null }) }, exec.signal)
      const answer = object(answers['result'])
      if (answer['type'] !== 'noul') throw new Error('TypeSafe returned the wrong answer type.')
      return { ...metadata, yes_probability: number(answer['noul'], 0, 1) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'typesafe_prune',
    description: 'Trim a long output by asking TypeSafe, per chunk, whether any line still needs to remain available; dropped chunks become "[N lines omitted]". Chunks are split by line count (long lines split first) and capped. Kept text stays verbatim. Sends the chunks and question to the external TypeSafe API.',
    parameters: {
      text: { type: 'string', required: true, description: 'The long output to prune.' },
      goal: { type: 'string', description: 'What you need from this output, used to judge relevance.' },
      chunk_lines: { type: 'integer', description: 'Lines grouped into each decision chunk (default 20).' },
      keep_threshold: { type: 'number', description: 'Minimum keep probability for a chunk to stay (default 0.5); first and last chunks are always kept.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        pruned: { type: 'string', required: true },
        kept_chunks: { type: 'integer', required: true },
        dropped_chunks: { type: 'integer', required: true },
        omitted_lines: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.pruned }],
    },
    async execute(args, exec) {
      nonempty(args.text)
      const chunkSize = args.chunk_lines ?? 20
      if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 200) throw new Error('chunk_lines must be an integer between 1 and 200.')
      const threshold = args.keep_threshold ?? PRUNE_KEEP_THRESHOLD
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('keep_threshold must be between 0 and 1.')
      const chunks = chunkLines(args.text, chunkSize)
      if (chunks.length === 0) throw new Error('Nothing to prune.')
      if (chunks.length === 1) {
        return { model: config.model, usage: { input_tokens: 0, output_tokens: 0 }, pruned: args.text, kept_chunks: 1, dropped_chunks: 0, omitted_lines: 0 }
      }
      if (chunks.length > PRUNE_MAX_CHUNKS) throw new Error(`Output splits into ${chunks.length} chunks; the maximum is ${PRUNE_MAX_CHUNKS}.`)
      const questions: Questions = {}
      for (let i = 0; i < chunks.length; i++) questions[`chunk_${i}`] = noul(`Does any line in chunk ${i} need to remain available?`)
      const state: Record<string, JsonValue> = { goal: args.goal ?? null, chunks: chunks.map(chunk => chunk.text) }
      const { model, usage, answers } = await call(state, questions, exec.signal)
      const keep: boolean[] = chunks.map((_, i) => {
        const answer = object(answers[`chunk_${i}`])
        if (answer['type'] !== 'noul') throw new Error('TypeSafe returned the wrong answer type.')
        const probability = number(answer['noul'], 0, 1)
        return probability >= threshold || i === 0 || i === chunks.length - 1
      })
      const out: string[] = []
      let omitted = 0
      let totalOmitted = 0
      let kept = 0
      let dropped = 0
      const flush = () => {
        if (omitted > 0) {
          out.push(`[${omitted} lines omitted]`)
          totalOmitted += omitted
          omitted = 0
        }
      }
      for (let i = 0; i < chunks.length; i++) {
        if (keep[i]!) {
          flush()
          out.push(chunks[i]!.text)
          kept += 1
        } else {
          omitted += chunks[i]!.lines
          dropped += 1
        }
      }
      flush()
      return { model, usage, pruned: out.join('\n'), kept_chunks: kept, dropped_chunks: dropped, omitted_lines: totalOmitted }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'typesafe_compact',
    description: 'Compact a transcript by asking TypeSafe, per tool call/result pair, whether the call and its result still need to stay; stale ones are dropped or truncated while everything kept stays verbatim. Text entries are never removed. Sends a fitted view of the transcript to the external TypeSafe API.',
    parameters: {
      entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true },
        result: { type: 'string' },
      } }, description: 'Transcript entries in order: a tool entry has `id`, `text` (call input), and `result`; a text entry has only `id` and `text`.' },
      goal: { type: 'string', description: 'The ongoing task, used to judge what still matters.' },
      preserve_recent: { type: 'integer', description: 'Number of newest entries never touched (default 6); the first entry is always kept.' },
      keep_threshold: { type: 'number', description: 'Minimum keep probability for a call or result to stay (default 0.5).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {
          id: { type: 'string', required: true },
          text: { type: 'string', required: true },
          result: { type: 'string' },
        } } },
        decisions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true },
          keep_call: { type: 'boolean', required: true },
          keep_result: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
        } } },
        stats: { type: 'object', additionalProperties: false, required: true, properties: {
          before: { type: 'integer', required: true },
          after: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
          truncated: { type: 'integer', required: true },
        } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!Array.isArray(args.entries) || args.entries.length === 0) throw new Error('Provide at least one transcript entry.')
      const ids = new Set<string>()
      for (const entry of args.entries) {
        if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('Every entry needs a non-empty id.')
        if (ids.has(entry.id)) throw new Error(`Duplicate entry id "${entry.id}".`)
        ids.add(entry.id)
        if (typeof entry.text !== 'string' || !entry.text.trim()) throw new Error(`Entry "${entry.id}" needs non-empty text.`)
        if (entry.result !== undefined && typeof entry.result !== 'string') throw new Error(`Entry "${entry.id}" result must be a string.`)
      }
      const preserveRecent = args.preserve_recent ?? COMPACT_PRESERVE_RECENT
      if (!Number.isInteger(preserveRecent) || preserveRecent < 0) throw new Error('preserve_recent must be a non-negative integer.')
      const threshold = args.keep_threshold ?? COMPACT_KEEP_THRESHOLD
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('keep_threshold must be between 0 and 1.')

      const entries = args.entries as Array<{ id: string; text: string; result?: string }>
      const toolEntries = entries.filter(entry => entry.result !== undefined)
      const decisionsOut: Array<{ id: string; keep_call: boolean; keep_result: boolean; action: string }> = []
      if (toolEntries.length === 0) {
        return { model: config.model, usage: { input_tokens: 0, output_tokens: 0 }, entries, decisions: decisionsOut, stats: { before: entries.length, after: entries.length, dropped: 0, truncated: 0 } }
      }

      const pinned = new Set<string>([entries[0]!.id])
      for (let i = Math.max(1, entries.length - preserveRecent); i < entries.length; i++) pinned.add(entries[i]!.id)
      const candidates = toolEntries.filter(entry => !pinned.has(entry.id))
      const questions: Questions = {}
      for (const entry of candidates) {
        questions[`call_${entry.id}`] = noul('Does knowing this tool call was made, with its input, still matter?')
        questions[`result_${entry.id}`] = noul('Is this tool result still needed verbatim; would re-running the tool not do?')
      }
      const stateEntries: Record<string, JsonValue>[] = entries.map(entry => {
        const item: Record<string, JsonValue> = { id: entry.id, text: truncate(entry.text, COMPACT_STATE_TEXT_CHARS) }
        if (entry.result !== undefined) item['result_note'] = `ok, ${entry.result.length} chars (omitted)`
        return item
      })
      const state: Record<string, JsonValue> = { goal: args.goal ?? null, entries: stateEntries }
      const { model, usage, answers } = await call(state, questions, exec.signal)
      const decisions = new Map<string, { keep_call: boolean; keep_result: boolean; action: 'keep' | 'truncate' | 'drop' }>()
      for (const entry of candidates) {
        const callAnswer = object(answers[`call_${entry.id}`])
        const resultAnswer = object(answers[`result_${entry.id}`])
        if (callAnswer['type'] !== 'noul' || resultAnswer['type'] !== 'noul') throw new Error('TypeSafe returned the wrong answer type.')
        const keepCall = number(callAnswer['noul'], 0, 1) >= threshold
        const keepResult = number(resultAnswer['noul'], 0, 1) >= threshold
        const action = keepResult ? 'keep' : keepCall ? 'truncate' : 'drop'
        decisions.set(entry.id, { keep_call: keepCall, keep_result: keepResult, action })
        decisionsOut.push({ id: entry.id, keep_call: keepCall, keep_result: keepResult, action })
      }
      const rebuilt: Array<{ id: string; text: string; result?: string }> = []
      let truncatedCount = 0
      for (const entry of entries) {
        if (entry.result === undefined) { rebuilt.push({ id: entry.id, text: entry.text }); continue }
        if (pinned.has(entry.id)) { rebuilt.push(entry); continue }
        const decision = decisions.get(entry.id)!
        if (decision.action === 'keep') rebuilt.push(entry)
        else if (decision.action === 'truncate') {
          truncatedCount += 1
          const head = truncate(entry.result, COMPACT_TRUNCATE_HEAD_CHARS)
          const omittedChars = entry.result.length - head.length
          rebuilt.push({ id: entry.id, text: entry.text, result: omittedChars > 0 ? `${head} … [${omittedChars} chars omitted]` : head })
        }
      }
      return {
        model, usage, entries: rebuilt, decisions: decisionsOut,
        stats: { before: entries.length, after: rebuilt.length, dropped: entries.length - rebuilt.length, truncated: truncatedCount },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'typesafe_generate',
    description: 'Generate a short continuation by asking TypeSafe, one choice per token, which token from a candidate set best continues the text. Greedy: each token is appended before the next question. Sends each step to the external TypeSafe API. Jev is a gate/ranker, not a generator, so results are a demonstration of ranking, not a language model.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Text to continue.' },
      candidates: { type: 'array', items: { type: 'string' }, required: true, description: 'Candidate tokens to choose from at each step (at least two, distinct).' },
      max_tokens: { type: 'integer', description: 'Maximum tokens to generate (default 10, capped at 50).' },
      stop: { type: 'array', items: { type: 'string' }, description: 'Tokens that end generation early.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        model: { type: 'string', required: true },
        usage: usageSchema,
        text: { type: 'string', required: true },
        tokens: { type: 'array', required: true, items: { type: 'string' } },
      } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      nonempty(args.prompt)
      if (!Array.isArray(args.candidates) || args.candidates.length < 2) throw new Error('Provide at least two candidate tokens.')
      if (new Set(args.candidates).size !== args.candidates.length) throw new Error('Candidate tokens must be distinct.')
      for (const candidate of args.candidates) if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('Candidate tokens must be non-empty strings.')
      const maxTokens = Math.min(args.max_tokens ?? GENERATE_DEFAULT_TOKENS, GENERATE_MAX_TOKENS_CAP)
      if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('max_tokens must be a positive integer.')
      const stop = new Set(args.stop ?? [])
      let textSoFar = args.prompt
      let inputTokens = 0
      let outputTokens = 0
      let model = config.model
      const tokens: string[] = []
      for (let i = 0; i < maxTokens; i++) {
        const state: Record<string, JsonValue> = { prompt: args.prompt, so_far: textSoFar }
        const { model: responseModel, usage, answers } = await call(state, {
          next: choice('Which token best continues this text?', Object.fromEntries(args.candidates.map(candidate => [candidate, null]))),
        }, exec.signal)
        model = responseModel
        inputTokens += usage.input_tokens
        outputTokens += usage.output_tokens
        const answer = object(answers['next'])
        if (answer['type'] !== 'choice') throw new Error('TypeSafe returned the wrong answer type.')
        const selected = text(answer['choice'])
        if (!args.candidates.includes(selected)) throw new Error('TypeSafe returned an unknown candidate.')
        tokens.push(selected)
        textSoFar = textSoFar ? `${textSoFar} ${selected}` : selected
        if (stop.has(selected)) break
      }
      return { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, text: textSoFar, tokens }
    },
  }))

  const patternSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    creator: { type: 'string', required: true },
    category: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    regexFlags: { type: 'string', required: true },
    caseSensitive: { type: 'boolean', required: true },
    note: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  } } as const
  const patternInputSchema = { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' },
    label: { type: 'string', required: true },
    creator: { type: 'string', required: true },
    category: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    regexFlags: { type: 'string' },
    caseSensitive: { type: 'boolean' },
    note: { type: 'string' },
  } } as const
  const patternExampleSchema = { type: 'object', additionalProperties: false, properties: {
    index: { type: 'integer', required: true },
    timestamp: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    match: { type: 'string', required: true },
    excerpt: { type: 'string', required: true },
  } } as const
  const patternSummarySchema = { type: 'object', additionalProperties: false, properties: {
    patternId: { type: 'string', required: true },
    label: { type: 'string', required: true },
    creator: { type: 'string', required: true },
    category: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    pattern: { type: 'string', required: true },
    matches: { type: 'integer', required: true },
    firstIndex: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    lastIndex: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    examples: { type: 'array', required: true, items: patternExampleSchema },
  } } as const
  const timeBucketSchema = { type: 'object', additionalProperties: false, properties: {
    start: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  } } as const
  const gapStatsSchema = { type: 'object', additionalProperties: false, properties: {
    matchCount: { type: 'integer', required: true },
    bucketSpanMs: { type: 'integer', required: true },
    meanGapMs: { type: 'integer', required: true },
    medianGapMs: { type: 'integer', required: true },
    minGapMs: { type: 'integer', required: true },
    maxGapMs: { type: 'integer', required: true },
    stddevGapMs: { type: 'integer', required: true },
    coefficientOfVariation: { type: 'number', required: true },
  } } as const
  const patternReportSchema = { type: 'object', additionalProperties: false, required: true, properties: {
    source: { type: 'string', required: true },
    generatedAt: { type: 'string', required: true },
    messageCount: { type: 'integer', required: true },
    patternsScanned: { type: 'integer', required: true },
    matchedPatterns: { type: 'integer', required: true },
    matchedMessages: { type: 'integer', required: true },
    totalMatches: { type: 'integer', required: true },
    matchedRate: { type: 'number', required: true },
    patterns: { type: 'array', required: true, items: patternSummarySchema },
    timeSeries: { type: 'array', required: true, items: timeBucketSchema },
    gapStats: { oneOf: [gapStatsSchema, { type: 'null' }], required: true },
  } } as const

  ctx.tools.register(defineTool({
    name: 'pattern_flag',
    description: 'Capture a bot signature you observed as a typed pattern record (no API call): a literal substring, whole-word match, or regular expression, attributed to a creator, with an optional note. Returns the normalized, validated record (id, kind, pattern, regexFlags, caseSensitive, note, timestamps) that you can hand to pattern_match or persist in a pattern store.',
    parameters: {
      label: { type: 'string', required: true, description: 'Human-readable name for the pattern.' },
      creator: { type: 'string', required: true, description: 'Who the pattern is attributed to (the creator, bot farm, or campaign).' },
      category: { type: 'string', required: true, description: 'Grouping label, e.g. "linguistic", "behavioral", "structural".' },
      kind: { type: 'string', required: true, description: 'How to match: "regex", "substring", or "word".' },
      pattern: { type: 'string', required: true, description: 'Regex source (kind "regex") or a literal string (kinds "substring"/"word").' },
      id: { type: 'string', description: 'Stable key; generated from the label when omitted.' },
      regexFlags: { type: 'string', description: 'Regex flags (e.g. "i", "mi"); ignored for substring/word.' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive literal matching; ignored for regex. Default false.' },
      note: { type: 'string', description: 'Free-text note or caveat.' },
    },
    output: {
      schema: patternSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const pattern = normalizePattern({
        id: args.id,
        label: args.label,
        creator: args.creator,
        category: args.category,
        kind: args.kind as PatternKind,
        pattern: args.pattern,
        regexFlags: args.regexFlags,
        caseSensitive: args.caseSensitive,
        note: args.note,
      })
      return pattern
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pattern_match',
    description: 'Scan a candidate transcript against your flagged patterns (regex, substring, or word) and return a bounded report: per-pattern matches and examples, a timestamped time series, and inter-match gap statistics. Matching is local and deterministic; it makes no API call. Returns the report plus a Markdown rendering.',
    parameters: {
      text: { type: 'string', required: true, description: 'Transcript of a candidate bot to scan (auto-detected log format).' },
      source: { type: 'string', description: 'Label used as the report title (defaults to "transcript").' },
      patterns: { type: 'array', required: true, items: patternInputSchema, description: 'Flagged patterns to match (at least one).' },
      limit: { type: 'integer', description: 'Maximum messages to scan (default ' + PATTERN_MATCH_MAX_MESSAGES + ').' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        report: patternReportSchema,
        markdown: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(args) {
      const messages = parseChatLog(args.text)
      if (messages.length === 0) throw new Error('No messages could be parsed from the transcript.')
      const limit = args.limit ?? PATTERN_MATCH_MAX_MESSAGES
      if (!Number.isInteger(limit) || limit < 1 || limit > PATTERN_MATCH_MAX_MESSAGES) {
        throw new Error('limit must be an integer between 1 and ' + PATTERN_MATCH_MAX_MESSAGES + '.')
      }
      const inputs = args.patterns as PatternInput[]
      if (inputs.length === 0) throw new Error('Provide at least one flagged pattern.')
      const patterns = inputs.map((input) => normalizePattern(input))
      const ids = new Set<string>()
      for (const pattern of patterns) {
        if (ids.has(pattern.id)) throw new Error('Duplicate pattern id "' + pattern.id + '".')
        ids.add(pattern.id)
      }
      const report = buildPatternReport(args.source ?? 'transcript', patterns, messages.slice(0, limit))
      validatePatternReport(report)
      return { report, markdown: renderPatternMarkdown(report) }
    },
  }))
}

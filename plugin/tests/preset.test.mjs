import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOT_PSYCHOLOGIST_SYSTEM_PROMPT } from '../lib/src/botdetect.js'

const here = dirname(fileURLToPath(import.meta.url))
const presetDir = join(here, '..', '..', 'psychologist')

test('the psychologist persona states its contract', () => {
  assert.match(BOT_PSYCHOLOGIST_SYSTEM_PROMPT, /analogue psychological test battery/)
  assert.match(BOT_PSYCHOLOGIST_SYSTEM_PROMPT, /machine-indicating/)
  assert.match(BOT_PSYCHOLOGIST_SYSTEM_PROMPT, /never state a verdict/i)
  assert.match(BOT_PSYCHOLOGIST_SYSTEM_PROMPT, /not proof/)
})

test('the psychologist preset composes the persona and the bot_detect bundle', () => {
  const composition = readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8')
  assert.match(composition, /name: '@deepseek-ai\/dsh-persona'/)
  assert.match(composition, /name: '@deepseek-ai\/dsh-typesafe-profiler'/)
  assert.match(composition, /bot_detect/)
  // The inlined persona must not drift from the exported prompt.
  assert.match(composition, /analogue psychological test battery/)
  assert.match(composition, /Never state a verdict to the subject/)
  // Without a key the bundle is disabled, so the persona still loads and the agent can converse.
  assert.match(composition, /disabled: !!js/)
})

test('the psychologist preset carries display metadata', () => {
  const meta = readFileSync(join(presetDir, 'preset.yml'), 'utf8')
  assert.match(meta, /name:/)
  assert.match(meta, /description:/)
})

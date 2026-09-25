import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPatternReport,
  coercePatternInput,
  compileMatcher,
  loadPatternStore,
  matchMessages,
  normalizePattern,
  parseTimestampMs,
  savePatternStore,
  validatePattern,
  validatePatternReport,
} from '../dist/patterns.js'

function msg(index, content, timestamp) {
  return { index, author: null, timestamp: timestamp ?? null, channel: null, content }
}

test('normalizePattern fills defaults and derives an id from the label', () => {
  const pattern = normalizePattern({ label: 'Canned apology', creator: 'acme', category: 'linguistic', kind: 'regex', pattern: 'I apologize' })
  assert.equal(pattern.id, 'canned-apology')
  assert.equal(pattern.regexFlags, '')
  assert.equal(pattern.caseSensitive, false)
  assert.equal(pattern.note, '')
  assert.ok(pattern.createdAt)
  assert.ok(pattern.updatedAt)
  validatePattern(pattern)
})

test('normalizePattern and coercePatternInput reject bad input', () => {
  assert.throws(() => normalizePattern({ label: 'x', creator: 'c', category: 'g', kind: 'fuzzy', pattern: 'x' }), /invalid kind/)
  assert.throws(() => normalizePattern({ label: 'x', creator: 'c', category: 'g', kind: 'regex', pattern: '(', regexFlags: 'z' }), /regular expression/)
  assert.throws(() => coercePatternInput(null), /must be a JSON object/)
  assert.throws(() => coercePatternInput({ label: 'x', creator: 'c', category: 'g', kind: 'substring' }), /missing required field "pattern"/)
  assert.throws(() => coercePatternInput({ label: 'x', creator: 'c', category: 'g', kind: 'fuzzy', pattern: 'x' }), /kind/)
})

test('compileMatcher matches regex, substring, and word kinds', () => {
  const regex = normalizePattern({ label: 'r', creator: 'c', category: 'g', kind: 'regex', pattern: 'client (secret|token)', regexFlags: 'i' })
  assert.ok(compileMatcher(regex)('I rotated the CLIENT SECRET last week'))
  assert.equal(compileMatcher(regex)('nothing here'), null)

  const substring = normalizePattern({ label: 's', creator: 'c', category: 'g', kind: 'substring', pattern: '500 error' })
  assert.ok(compileMatcher(substring)('a 500 ERROR occurred'))
  const word = normalizePattern({ label: 'w', creator: 'c', category: 'g', kind: 'word', pattern: 'green' })
  assert.ok(compileMatcher(word)('everything is green now'))
  assert.equal(compileMatcher(word)('the greenhouse effect'), null)

  const caseWord = normalizePattern({ label: 'cw', creator: 'c', category: 'g', kind: 'word', pattern: 'Green', caseSensitive: true })
  assert.ok(compileMatcher(caseWord)('Green is the color'))
  assert.equal(compileMatcher(caseWord)('green is the color'), null)
})

test('matchMessages aligns per-pattern matches and scrubs identifiers', () => {
  const pattern = normalizePattern({ label: 'contact', creator: 'c', category: 'g', kind: 'substring', pattern: 'reach me' })
  const messages = [msg(1, 'You can reach me at alice@example.com or @alice_handle anytime', null)]
  const [matches] = matchMessages([pattern], messages)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].messageIndex, 1)
  assert.ok(matches[0].excerpt.includes('[email]'))
  assert.ok(matches[0].excerpt.includes('@handle'))
})

test('parseTimestampMs parses log timestamps and rejects undated strings', () => {
  assert.equal(parseTimestampMs('2024-01-03 10:02:11') !== null, true)
  assert.equal(parseTimestampMs('2024-01-03T10:02:11Z') !== null, true)
  assert.equal(parseTimestampMs('Today at 10:02 AM'), null)
  assert.equal(parseTimestampMs(''), null)
})

test('buildPatternReport counts matches, builds a time series, and computes gaps', () => {
  const patterns = [
    normalizePattern({ label: 'Server 500', creator: 'c', category: 'g', kind: 'substring', pattern: '500 error' }),
    normalizePattern({ label: 'green', creator: 'c', category: 'g', kind: 'word', pattern: 'green' }),
  ]
  const messages = [
    msg(1, 'I see a 500 error here', '2024-01-03 10:02:00'),
    msg(2, 'nothing to see', '2024-01-03 10:04:00'),
    msg(3, 'all green now', '2024-01-03 11:17:00'),
  ]
  const report = buildPatternReport('demo', patterns, messages)
  validatePatternReport(report)
  assert.equal(report.matchedMessages, 2)
  assert.equal(report.matchedPatterns, 2)
  assert.equal(report.totalMatches, 2)
  assert.ok(Math.abs(report.matchedRate - 2 / 3) < 0.001)
  assert.ok(report.timeSeries.length > 0)
  assert.equal(report.gapStats.matchCount, 2)
})

test('buildPatternReport with no timestamps yields an empty series and null gaps', () => {
  const pattern = normalizePattern({ label: 'plain', creator: 'c', category: 'g', kind: 'substring', pattern: 'plain' })
  const report = buildPatternReport('raw', [pattern], [msg(1, 'a plain message', null), msg(2, 'another plain message', null)])
  validatePatternReport(report)
  assert.deepEqual(report.timeSeries, [])
  assert.equal(report.gapStats, null)
})

test('validatePatternReport rejects an out-of-range matched rate', () => {
  const pattern = normalizePattern({ label: 'p', creator: 'c', category: 'g', kind: 'substring', pattern: 'x' })
  const report = buildPatternReport('bad', [pattern], [msg(1, 'x', null)])
  report.matchedRate = 2
  assert.throws(() => validatePatternReport(report), /matchedRate/)
})

test('the pattern store round-trips through a JSON file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patterns-'))
  const path = join(dir, 'store.json')
  const pattern = normalizePattern({ label: 'Canned apology', creator: 'acme', category: 'linguistic', kind: 'substring', pattern: 'I apologize' })
  savePatternStore(path, [pattern])
  const loaded = loadPatternStore(path)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'canned-apology')
  assert.equal(loaded[0].updatedAt, pattern.updatedAt)
  rmSync(dir, { recursive: true, force: true })
})

test('loading a missing store returns an empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patterns-'))
  const loaded = loadPatternStore(join(dir, 'missing.json'))
  assert.deepEqual(loaded, [])
  rmSync(dir, { recursive: true, force: true })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GUARD_POLICIES,
  buildHazards,
  guardProfile,
  hazardTriggered,
  renderGuardMarkdown,
  route,
  validateGuardReport,
} from '../dist/guard.js'

const strict = GUARD_POLICIES.strict

function profileFixture() {
  return {
    source: 'demo',
    dimensions: [
      { id: 'frustration_hostility', polarity: 'inverted-risk', score: 0.9, n: 5, stable: true, confidence: 0.8 },
      { id: 'escalation_readiness', polarity: 'inverted-risk', score: 0.2, n: 5, stable: true, confidence: 0.8 },
      { id: 'cognitive_rigidity', polarity: 'inverted-risk', score: 0.2, n: 5, stable: true, confidence: 0.8 },
    ],
  }
}

test('route blocks a fired hazard and promotes a review to block under severity', () => {
  const actionFor = { harmful_request: 'block', medical_advice: 'review' }
  assert.equal(route({ harmful_request: 0.9, medical_advice: 0.1 }, actionFor, 0, strict), 'block')
  assert.equal(route({ harmful_request: 0.1, medical_advice: 0.6 }, actionFor, 0.8, strict), 'block')
  assert.equal(route({ harmful_request: 0.1, medical_advice: 0.6 }, actionFor, 0.1, strict), 'review')
})

test('route resolves precedence support > block > review > pass', () => {
  const actionFor = { self_harm: 'support', jailbreak: 'block', medical_advice: 'review' }
  assert.equal(route({ self_harm: 0.9, jailbreak: 0.9, medical_advice: 0.9 }, actionFor, 0, strict), 'support')
  assert.equal(route({ self_harm: 0.1, jailbreak: 0.9, medical_advice: 0.9 }, actionFor, 0, strict), 'block')
  assert.equal(route({ self_harm: 0.1, jailbreak: 0.1, medical_advice: 0.6 }, actionFor, 0, strict), 'review')
  assert.equal(route({ self_harm: 0.1, jailbreak: 0.1, medical_advice: 0.1 }, actionFor, 0, strict), 'pass')
})

test('hazardTriggered returns null below the review threshold', () => {
  assert.equal(hazardTriggered(0.4, 'block', 0, strict), null)
  assert.equal(hazardTriggered(0.6, 'block', 0, strict), 'review')
  assert.equal(hazardTriggered(0.9, 'review', 0.8, strict), 'block')
})

test('buildHazards maps inverted-risk scores and meta flags', () => {
  const profile = profileFixture()
  profile.dimensions[2].n = 2
  profile.dimensions[2].stable = false
  const hazards = buildHazards(profile)
  assert.equal(hazards.frustration_hostility, 0.9)
  assert.equal(hazards.escalation_readiness, 0.2)
  assert.equal(hazards.cognitive_rigidity, 0.2)
  assert.equal(hazards.unstable, 1)
  assert.equal(hazards.low_confidence, 0)
})

test('buildHazards sets low_confidence when the mean confidence is low', () => {
  const profile = {
    source: 'demo',
    dimensions: [
      { id: 'frustration_hostility', polarity: 'inverted-risk', score: 0.1, n: 2, stable: false, confidence: 0.3 },
    ],
  }
  const hazards = buildHazards(profile)
  assert.equal(hazards.unstable, 1)
  assert.equal(hazards.low_confidence, 1)
})

test('guardProfile routes a hostile profile to block and flags the fired hazard', () => {
  const report = guardProfile(profileFixture(), { selfHarm: 0.05, severity: 0.2 }, 'strict', { input_tokens: 1, output_tokens: 1 })
  assert.equal(report.action, 'block')
  assert.deepEqual(report.flagged, ['frustration_hostility'])
  validateGuardReport(report)
})

test('guardProfile routes self-harm to support ahead of a block', () => {
  const report = guardProfile(profileFixture(), { selfHarm: 0.95, severity: 0.9 }, 'strict', { input_tokens: 1, output_tokens: 1 })
  assert.equal(report.action, 'support')
  assert.deepEqual(report.flagged, ['frustration_hostility', 'self_harm'])
  validateGuardReport(report)
})

test('guardProfile rejects an unknown policy', () => {
  assert.throws(() => guardProfile(profileFixture(), { selfHarm: 0, severity: 0 }, 'nope', { input_tokens: 0, output_tokens: 0 }), /Unknown guard policy/)
})

test('validateGuardReport rejects an unknown action', () => {
  const report = guardProfile(profileFixture(), { selfHarm: 0, severity: 0 }, 'strict', { input_tokens: 0, output_tokens: 0 })
  report.action = 'nope'
  assert.throws(() => validateGuardReport(report), /invalid action/)
})

test('renderGuardMarkdown shows the decision and hazard table', () => {
  const report = guardProfile(profileFixture(), { selfHarm: 0, severity: 0 }, 'strict', { input_tokens: 0, output_tokens: 0 })
  const md = renderGuardMarkdown(report)
  assert.match(md, /# Profile Guard: demo/)
  assert.match(md, /Decision: BLOCK/)
  assert.match(md, /Frustration \/ hostility/)
  assert.match(md, /## Flagged/)
})

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  evaluateReplacementEligibility,
  transcriptCompletionTransition,
} = require('../src/services/interviewLifecycle');

test('completed substantive attempt permanently blocks a replacement', () => {
  const result = evaluateReplacementEligibility({
    candidate: { status: 'Interview Completed' },
    attempts: [{ status: 'Analyzed', has_substantive_response: true }],
    resetEvents: [],
  });
  assert.deepEqual(result, { eligible: false, code: 'completed_interview_retake_blocked' });
});

test('only a failed or incomplete attempt with no active attempt is eligible once', () => {
  const eligible = evaluateReplacementEligibility({
    candidate: { status: 'Verified' },
    attempts: [{ id: 'first', attempt_number: 1, status: 'Incomplete', has_substantive_response: false, replacement_eligible: true }],
    resetEvents: [],
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.latestAttemptId, 'first');

  const active = evaluateReplacementEligibility({
    candidate: { status: 'Verified' },
    attempts: [{ status: 'Pending', is_active: true }],
    resetEvents: [],
  });
  assert.equal(active.code, 'active_interview_attempt_exists');
});

test('no-substantive evidence transitions to incomplete rather than analysis', () => {
  const transition = transcriptCompletionTransition({ ok: false });
  assert.equal(transition.status, 'Incomplete');
  assert.equal(transition.failure_code, 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE');
  assert.equal(transition.replacement_eligible, true);
});

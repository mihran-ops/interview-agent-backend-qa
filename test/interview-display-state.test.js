'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { classifyInterviewDisplayState } = require('../src/services/interviewDisplayState');

test('dashboard interview states are concise and do not expose raw failure details', () => {
  assert.deepEqual(classifyInterviewDisplayState(null), { state: 'not_started', label: 'Not started' });
  assert.deepEqual(classifyInterviewDisplayState({ status: 'completed' }, { hasScore: true }), { state: 'scored', label: 'Scored' });
  assert.deepEqual(classifyInterviewDisplayState({
    status: 'Incomplete',
    failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
  }, { hasScore: true }), { state: 'no_response', label: 'No response' });
  assert.deepEqual(classifyInterviewDisplayState({
    status: 'failed',
    failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
    client_end_reason: 'participant_left_timeout',
  }), { state: 'no_response', label: 'No response' });
  assert.deepEqual(classifyInterviewDisplayState({
    status: 'failed',
    failure_code: 'INTERVIEW_DISCONNECTED',
    retryable: true,
  }), { state: 'tech_issue', label: 'Tech issue' });
  assert.deepEqual(classifyInterviewDisplayState({ status: 'transcribing' }), { state: 'processing', label: 'Processing' });
  for (const status of ['Ended', 'Transcribed', 'TranscriptionReceived', 'ReadyForAnalysis', 'Video Ready', 'ending_requested']) {
    assert.deepEqual(
      classifyInterviewDisplayState({ status }, { hasScore: false }),
      { state: 'processing', label: 'Processing' },
      status,
    );
  }
  assert.deepEqual(
    classifyInterviewDisplayState({ status: 'Analyzed' }, { hasScore: true }),
    { state: 'scored', label: 'Scored' },
  );
  assert.deepEqual(
    classifyInterviewDisplayState({ status: 'Incomplete', replacement_eligible: true, retryable: true }),
    { state: 'incomplete', label: 'Incomplete' },
  );
  assert.deepEqual(classifyInterviewDisplayState({ status: 'candidate_ended' }), { state: 'incomplete', label: 'Incomplete' });
});

test('dashboard uses the canonical unanswered-question array without querying a missing fallback column', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'client', 'dashboardRouter.js'), 'utf8');
  assert.doesNotMatch(source, /unanswered_candidate_questions_text/);
  assert.match(source, /interview_state_label/);
  assert.match(source, /iv\?\.has_substantive_response === false/);
});

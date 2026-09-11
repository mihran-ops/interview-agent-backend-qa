'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  classifyCandidateUtterance,
  classifyTranscriptCandidateEvidence,
} = require('../src/services/interviewUtteranceClassifier');

test('candidate clarification, repeat, audio, acknowledgement, and filler are never substantive', () => {
  for (const input of [
    'What did you ask me?',
    'Could you repeat that please?',
    'I cannot hear you clearly.',
    'Okay, thank you.',
    'Um...',
  ]) {
    assert.equal(classifyCandidateUtterance(input).substantive, false, input);
  }
});

test('concrete candidate answers, including concise technical answers, are substantive', () => {
  assert.equal(classifyCandidateUtterance('I used Python to automate the reporting workflow.').classification, 'substantive_answer');
  assert.equal(classifyCandidateUtterance('In my last role, I led a migration that reduced processing time by 40 percent.').substantive, true);
});

test('transcript evidence requires at least one substantive labelled candidate answer', () => {
  const noEvidence = classifyTranscriptCandidateEvidence([
    'INTERVIEWER: Tell me about your experience.',
    'CANDIDATE: What did you ask me?',
    'CANDIDATE: Can you repeat that?',
  ].join('\n'));
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.reason, 'no_substantive_candidate_response');

  const mixed = classifyTranscriptCandidateEvidence([
    'INTERVIEWER: Tell me about your experience.',
    'CANDIDATE: Can you repeat that?',
    'CANDIDATE: I led a data migration and used SQL to validate every batch before release.',
  ].join('\n'));
  assert.equal(mixed.ok, true);
  assert.equal(mixed.substantiveResponseCount, 1);
});

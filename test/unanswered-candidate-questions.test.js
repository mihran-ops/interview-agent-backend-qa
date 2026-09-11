'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCandidateQuestions,
} = require('../src/services/unansweredCandidateQuestions');

const closing = {
  role: 'assistant',
  content: 'Do you have any questions before we wrap up?',
};
const questionOne = {
  role: 'user',
  content: 'Could you share a synthetic detail about the role?',
};
const questionTwo = {
  role: 'user',
  content: 'What is the synthetic onboarding sequence?',
};
const answer = {
  role: 'assistant',
  content: 'The synthetic role follows a documented onboarding sequence.',
};

test('candidate question followed by a substantive replica answer is not unanswered', () => {
  assert.deepEqual(extractCandidateQuestions([closing, questionOne, answer]), []);
});

test('answered closing question stays answered after a candidate acknowledgment', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    answer,
    { role: 'user', content: 'Thank you, that addresses my synthetic question.' },
  ]), []);
});

test('candidate question followed directly by termination remains unanswered', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    { role: 'system', content: 'synthetic termination' },
  ]), [questionOne.content]);
});

test('empty replica turn does not prove an answer', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    { role: 'assistant', content: '' },
  ]), [questionOne.content]);
});

test('partial replica output followed by completed authoritative response is answered', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    { role: 'assistant', content: 'A partial synthetic response', status: 'interrupted' },
    answer,
  ]), []);
});

test('multiple candidate questions with responses are independently answered in order', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    answer,
    questionTwo,
    { role: 'assistant', content: 'The second synthetic response is documented.' },
  ]), []);
});

test('only the unresolved candidate question remains', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    answer,
    questionTwo,
  ]), [questionTwo.content]);
});

test('ordinary candidate statement does not become a question', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    { role: 'user', content: 'I appreciate the synthetic explanation.' },
    answer,
  ]), []);
});

test('duplicate processing is deterministic and idempotent', () => {
  const turns = [closing, questionOne, answer];
  const first = extractCandidateQuestions(turns);
  const second = extractCandidateQuestions(turns);
  assert.deepEqual(first, []);
  assert.deepEqual(second, first);
});

test('a nonempty replica response answers a marker without judging adequacy', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    {
      role: 'user',
      content: 'Synthetic statement. [[UNANSWERED_QUESTION: Could you confirm the synthetic policy?]]',
    },
    {
      role: 'assistant',
      content: 'I cannot confirm that policy, but I will note it for the hiring manager.',
    },
  ]), []);
});

test('a marker without a later replica response remains unanswered', () => {
  const markerQuestion = 'Could you confirm the synthetic policy?';
  assert.deepEqual(extractCandidateQuestions([{
    role: 'user',
    content: `Synthetic statement. [[UNANSWERED_QUESTION: ${markerQuestion}]]`,
  }]), [markerQuestion]);
});

test('provider metadata and speaking events do not prove an answer', () => {
  assert.deepEqual(extractCandidateQuestions([
    closing,
    questionOne,
    { role: 'system', content: 'speaking_started', provider_id: 'synthetic' },
    { role: 'assistant', metadata: { state: 'speaking' } },
  ]), [questionOne.content]);
});

test('malformed ordered-turn evidence retains detectable questions fail closed', () => {
  const markerQuestion = 'Could you confirm the synthetic policy?';
  assert.deepEqual(extractCandidateQuestions([
    {
      role: null,
      content: `[[UNANSWERED_QUESTION: ${markerQuestion}]]`,
    },
    {
      role: 'assistant',
      content: { metadata_only: true },
    },
  ]), [markerQuestion]);
  assert.deepEqual(extractCandidateQuestions({ malformed: true }), []);
});

test('flattened authoritative transcripts preserve the same ordered semantics', () => {
  assert.deepEqual(extractCandidateQuestions([
    `INTERVIEWER: ${closing.content}`,
    `CANDIDATE: ${questionOne.content}`,
    `INTERVIEWER: ${answer.content}`,
  ].join('\n')), []);
  assert.deepEqual(extractCandidateQuestions([
    `INTERVIEWER: ${closing.content}`,
    `CANDIDATE: ${questionOne.content}`,
  ].join('\n')), [questionOne.content]);
});

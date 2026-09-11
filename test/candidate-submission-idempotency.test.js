'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CandidateSubmissionKeyError,
  normalizeSubmissionKey,
  reserveCandidateSubmission
} = require('../src/services/candidateSubmissionIdempotency');

const ROLE_ID = '11111111-1111-4111-8111-111111111111';
const SUBMISSION_KEY = '550e8400-e29b-41d4-a716-446655440000';

function fakeDb(results) {
  const queue = [...results];
  return {
    from() {
      const result = queue.shift();
      const builder = {
        insert() { return builder; },
        update() { return builder; },
        select() { return builder; },
        eq() { return builder; },
        async maybeSingle() { return result; }
      };
      return builder;
    }
  };
}

test('candidate submission keys are normalized UUIDs', () => {
  assert.equal(
    normalizeSubmissionKey(' 550E8400-E29B-41D4-A716-446655440000 '),
    '550e8400-e29b-41d4-a716-446655440000'
  );
  assert.equal(normalizeSubmissionKey(''), null);
  assert.throws(() => normalizeSubmissionKey('not-a-uuid'), CandidateSubmissionKeyError);
});

test('first submission acquires the idempotency reservation', async () => {
  const row = { id: 'request-1', status: 'processing', updated_at: new Date().toISOString() };
  const result = await reserveCandidateSubmission(fakeDb([{ data: row, error: null }]), {
    roleId: ROLE_ID,
    submissionKey: SUBMISSION_KEY
  });
  assert.equal(result.state, 'acquired');
  assert.equal(result.row.id, row.id);
});

test('completed submissions replay their stored response', async () => {
  const row = {
    id: 'request-1',
    status: 'completed',
    response_status: 200,
    response_body: { candidate_id: 'candidate-1' },
    updated_at: new Date().toISOString()
  };
  const result = await reserveCandidateSubmission(fakeDb([
    { data: null, error: { code: '23505' } },
    { data: row, error: null }
  ]), {
    roleId: ROLE_ID,
    submissionKey: SUBMISSION_KEY
  });
  assert.equal(result.state, 'replay');
  assert.deepEqual(result.row.response_body, row.response_body);
});

test('concurrent submissions report processing instead of acquiring twice', async () => {
  const row = { id: 'request-1', status: 'processing', updated_at: new Date().toISOString() };
  const result = await reserveCandidateSubmission(fakeDb([
    { data: null, error: { code: '23505' } },
    { data: row, error: null }
  ]), {
    roleId: ROLE_ID,
    submissionKey: SUBMISSION_KEY
  });
  assert.equal(result.state, 'processing');
});

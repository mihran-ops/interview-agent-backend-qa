'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildCandidateError, getInterviewConflictCode } = require('../src/services/candidateErrors');

test('candidate error responses expose stable candidate-safe codes', () => {
  const completed = buildCandidateError('INTERVIEW_ALREADY_COMPLETED', { request_id: 'request-1' });
  assert.equal(completed.status, 409);
  assert.equal(completed.payload.code, 'INTERVIEW_ALREADY_COMPLETED');
  assert.equal(completed.payload.request_id, 'request-1');
  assert.equal(completed.payload.retryable, false);

  const upload = buildCandidateError('RESUME_UPLOAD_FAILED');
  assert.equal(upload.status, 503);
  assert.equal(upload.payload.code, 'RESUME_UPLOAD_FAILED');
  assert.equal(upload.payload.retryable, true);

  const stale = buildCandidateError('STALE_ACCESS_INVALIDATED');
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error, 'stale_access_invalidated');
});

test('interview conflict codes distinguish completed, active, and reset-required states', () => {
  assert.equal(getInterviewConflictCode('Analyzed'), 'INTERVIEW_ALREADY_COMPLETED');
  assert.equal(getInterviewConflictCode('Starting'), 'INTERVIEW_IN_PROGRESS');
  assert.equal(getInterviewConflictCode('Pending'), 'INTERVIEW_IN_PROGRESS');
  assert.equal(getInterviewConflictCode('Incomplete'), 'RETAKE_AUTHORIZATION_REQUIRED');
  assert.equal(getInterviewConflictCode('Failed'), 'RETAKE_AUTHORIZATION_REQUIRED');
});

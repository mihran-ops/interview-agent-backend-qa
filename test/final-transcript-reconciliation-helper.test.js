'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  CLASSIFICATION_KEYS,
  buildEvidenceSnapshot,
  compareLegacyCurrentEvidence,
  compareEvidenceSnapshots,
  projectReconciliationLog,
  selectAuthoritativeSnapshot,
  validateTranscriptScores,
  validateLegacyEvidenceSnapshot,
  validateEvidenceSnapshot,
} = require('../src/services/finalTranscriptReconciliation');

const substantiveEvidence = {
  ok: true,
  reason: null,
  counts: { substantive_answer: 1, acknowledgment: 1 },
  candidateUtteranceCount: 2,
  substantiveResponseCount: 1,
  utterances: [
    { classification: 'substantive_answer', substantive: true, wordCount: 11 },
    { classification: 'acknowledgment', substantive: false, wordCount: 1 },
  ],
};

const validTranscriptScores = {
  overall: 70,
  role_fit: 71,
  technical_strength: 72,
  communication_quality: 73,
  confidence: 74,
  ai_aided_risk: 'low',
  ai_aided_risk_reason: 'Bounded synthetic reason.',
};

function assertInvalidTranscriptScores(scores, category) {
  assert.deepEqual(validateTranscriptScores(scores), {
    valid: false,
    category,
  });
}

test('transcript score validation accepts the exact source-derived contract and boundaries', () => {
  for (const scores of [
    validTranscriptScores,
    {
      ...validTranscriptScores,
      overall: 0,
      role_fit: 0,
      technical_strength: 0,
      communication_quality: 0,
      confidence: 0,
    },
    {
      ...validTranscriptScores,
      overall: 100,
      role_fit: 100,
      technical_strength: 100,
      communication_quality: 100,
      confidence: 100,
    },
    {
      ...validTranscriptScores,
      overall: null,
      role_fit: null,
      technical_strength: null,
      communication_quality: null,
      confidence: null,
    },
    { ...validTranscriptScores, ai_aided_risk: 'medium' },
    { ...validTranscriptScores, ai_aided_risk: 'high' },
    { ...validTranscriptScores, ai_aided_risk_reason: '' },
  ]) {
    assert.deepEqual(validateTranscriptScores(scores), { valid: true });
  }
});

test('transcript score validation rejects missing, unknown, malformed, and unsafe values', () => {
  assertInvalidTranscriptScores({}, 'missing_key');
  assertInvalidTranscriptScores(null, 'invalid_type');
  assertInvalidTranscriptScores([], 'invalid_type');

  for (const key of Object.keys(validTranscriptScores)) {
    const missing = { ...validTranscriptScores };
    delete missing[key];
    assertInvalidTranscriptScores(missing, 'missing_key');
  }
  assertInvalidTranscriptScores({ ...validTranscriptScores, unexpected: true }, 'unknown_key');

  for (const key of [
    'overall',
    'role_fit',
    'technical_strength',
    'communication_quality',
    'confidence',
  ]) {
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: '70' }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: true }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: {} }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: [] }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: Number.NaN }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: Number.POSITIVE_INFINITY }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: Number.NEGATIVE_INFINITY }, 'invalid_type');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: -1 }, 'out_of_range');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: 101 }, 'out_of_range');
    assertInvalidTranscriptScores({ ...validTranscriptScores, [key]: 1.5 }, 'invalid_type');
  }

  assertInvalidTranscriptScores({ ...validTranscriptScores, overall: null }, 'invalid_type');
  assertInvalidTranscriptScores({ ...validTranscriptScores, ai_aided_risk: 'unknown' }, 'invalid_enum');
  for (const invalidRisk of [null, 1, true, {}, []]) {
    assertInvalidTranscriptScores({
      ...validTranscriptScores,
      ai_aided_risk: invalidRisk,
    }, 'invalid_type');
  }
  for (const invalidReason of [null, 1, true, {}, []]) {
    assertInvalidTranscriptScores({
      ...validTranscriptScores,
      ai_aided_risk_reason: invalidReason,
    }, 'invalid_type');
  }
  assertInvalidTranscriptScores({
    ...validTranscriptScores,
    ai_aided_risk_reason: ' untrimmed',
  }, 'invalid_type');
  assertInvalidTranscriptScores({
    ...validTranscriptScores,
    ai_aided_risk_reason: '\u00a0untrimmed',
  }, 'invalid_type');
  assertInvalidTranscriptScores({
    ...validTranscriptScores,
    ai_aided_risk_reason: 'unsafe\u0000text',
  }, 'invalid_type');
  assertInvalidTranscriptScores({
    ...validTranscriptScores,
    ai_aided_risk_reason: '\ud800',
  }, 'invalid_type');
  assertInvalidTranscriptScores({
    ...validTranscriptScores,
    ai_aided_risk_reason: 'x'.repeat(20_000),
  }, 'oversized');
});

test('transcript score validation rejects inherited keys, accessors, and unusual prototypes', () => {
  const inheritedOnly = Object.create(validTranscriptScores);
  assertInvalidTranscriptScores(inheritedOnly, 'invalid_type');

  const unusualPrototype = Object.assign(Object.create({ inherited: true }), validTranscriptScores);
  assertInvalidTranscriptScores(unusualPrototype, 'invalid_type');

  let getterInvoked = false;
  const accessor = { ...validTranscriptScores };
  Object.defineProperty(accessor, 'overall', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 70;
    },
  });
  assertInvalidTranscriptScores(accessor, 'invalid_type');
  assert.equal(getterInvoked, false);
});

test('final transcript snapshot uses the exact deterministic classifier allowlist', () => {
  assert.deepEqual(CLASSIFICATION_KEYS, [
    'acknowledgment',
    'repeat_request',
    'hearing_or_audio_issue',
    'clarification_request',
    'filler',
    'silence_or_empty',
    'unknown_non_substantive',
    'substantive_answer',
  ]);
  const snapshot = buildEvidenceSnapshot(substantiveEvidence);
  assert.deepEqual(snapshot, {
    has_substantive_response: true,
    substantive_response_count: 1,
    candidate_utterance_count: 2,
    candidate_word_count: 12,
    classification_counts: {
      acknowledgment: 1,
      substantive_answer: 1,
    },
    conversation_progress_state: 'CandidateResponded',
  });
  assert.deepEqual(validateEvidenceSnapshot(snapshot), { ok: true, reason: null });
});

test('snapshot validation rejects unknown keys and malformed or incoherent counts', () => {
  const valid = buildEvidenceSnapshot(substantiveEvidence);
  for (const [name, snapshot] of [
    ['unknown classification', {
      ...valid,
      classification_counts: { ...valid.classification_counts, arbitrary_provider_key: 1 },
      candidate_utterance_count: 3,
    }],
    ['classification sum mismatch', { ...valid, candidate_utterance_count: 3 }],
    ['substantive count mismatch', { ...valid, substantive_response_count: 2 }],
    ['boolean mismatch', { ...valid, has_substantive_response: false }],
    ['fractional count', { ...valid, candidate_word_count: 1.5 }],
    ['unknown snapshot field', { ...valid, arbitrary: true }],
  ]) {
    const result = validateEvidenceSnapshot(snapshot);
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /invalid|unknown|mismatch|incoherent/, name);
  }
});

test('whole-snapshot comparison is monotonic and deterministic', () => {
  const strong = buildEvidenceSnapshot(substantiveEvidence);
  const sparse = buildEvidenceSnapshot({
    ok: false,
    reason: 'no_substantive_candidate_response',
    counts: { acknowledgment: 1 },
    candidateUtteranceCount: 1,
    substantiveResponseCount: 0,
    utterances: [{ classification: 'acknowledgment', substantive: false, wordCount: 1 }],
  });
  assert.equal(compareEvidenceSnapshots(strong, sparse), 1);
  assert.equal(compareEvidenceSnapshots(sparse, strong), -1);
  assert.equal(compareEvidenceSnapshots(strong, structuredClone(strong)), 0);

  assert.deepEqual(selectAuthoritativeSnapshot({
    currentSnapshot: strong,
    currentTranscriptHash: 'a'.repeat(64),
    incomingSnapshot: sparse,
    incomingTranscriptHash: 'b'.repeat(64),
  }), { source: 'current', snapshot: strong, reason: 'stronger_current_snapshot' });

  assert.deepEqual(selectAuthoritativeSnapshot({
    currentSnapshot: sparse,
    currentTranscriptHash: 'a'.repeat(64),
    incomingSnapshot: strong,
    incomingTranscriptHash: 'b'.repeat(64),
  }), { source: 'incoming', snapshot: strong, reason: 'stronger_incoming_snapshot' });

  assert.deepEqual(selectAuthoritativeSnapshot({
    currentSnapshot: strong,
    currentTranscriptHash: 'a'.repeat(64),
    incomingSnapshot: structuredClone(strong),
    incomingTranscriptHash: 'b'.repeat(64),
  }), { source: 'current', snapshot: strong, reason: 'equal_strength_existing_authoritative' });
});

test('legacy current evidence preserves equality when candidate word count is unknown', () => {
  const incoming = buildEvidenceSnapshot(substantiveEvidence);
  const legacyCurrent = {
    has_substantive_response: incoming.has_substantive_response,
    substantive_response_count: incoming.substantive_response_count,
    candidate_utterance_count: incoming.candidate_utterance_count,
    classification_counts: structuredClone(incoming.classification_counts),
    conversation_progress_state: incoming.conversation_progress_state,
  };
  assert.deepEqual(validateLegacyEvidenceSnapshot(legacyCurrent), { ok: true, reason: null });
  assert.equal(compareLegacyCurrentEvidence(legacyCurrent, incoming), 0);

  const moreUtterances = {
    ...incoming,
    candidate_utterance_count: incoming.candidate_utterance_count + 1,
    candidate_word_count: incoming.candidate_word_count + 1,
    classification_counts: {
      ...incoming.classification_counts,
      acknowledgment: (incoming.classification_counts.acknowledgment || 0) + 1,
    },
  };
  assert.equal(compareLegacyCurrentEvidence(legacyCurrent, moreUtterances), -1);

  const moreSubstantive = {
    ...incoming,
    substantive_response_count: incoming.substantive_response_count + 1,
    candidate_utterance_count: incoming.candidate_utterance_count + 1,
    candidate_word_count: incoming.candidate_word_count + 1,
    classification_counts: {
      ...incoming.classification_counts,
      substantive_answer: (incoming.classification_counts.substantive_answer || 0) + 1,
    },
  };
  assert.equal(compareLegacyCurrentEvidence(legacyCurrent, moreSubstantive), -1);

  const nonSubstantiveIncoming = {
    has_substantive_response: false,
    substantive_response_count: 0,
    candidate_utterance_count: 20,
    candidate_word_count: 2_000,
    classification_counts: { unknown_non_substantive: 20 },
    conversation_progress_state: 'NoSubstantiveCandidateResponse',
  };
  assert.equal(compareLegacyCurrentEvidence(legacyCurrent, nonSubstantiveIncoming), 1);
});

test('legacy current evidence rejects malformed or invented word-count fields', () => {
  const incoming = buildEvidenceSnapshot(substantiveEvidence);
  const legacyCurrent = {
    has_substantive_response: incoming.has_substantive_response,
    substantive_response_count: incoming.substantive_response_count,
    candidate_utterance_count: incoming.candidate_utterance_count,
    classification_counts: structuredClone(incoming.classification_counts),
    conversation_progress_state: incoming.conversation_progress_state,
  };
  assert.equal(validateLegacyEvidenceSnapshot({
    ...legacyCurrent,
    candidate_word_count: 0,
  }).ok, false);
  assert.equal(validateLegacyEvidenceSnapshot({
    ...legacyCurrent,
    score_derived_candidate_word_count: 'malformed',
  }).ok, false);
  assert.throws(
    () => compareLegacyCurrentEvidence({ ...legacyCurrent, candidate_word_count: 0 }, incoming),
    /unknown_legacy_snapshot_key/,
  );
});

test('bounded reconciliation logging excludes identities, content, tokens, and arbitrary keys', () => {
  const log = projectReconciliationLog({
    outcome: 'claimed',
    claimVersion: 2,
    scoringPerformed: true,
    canonicalRepair: true,
    authoritativeSnapshotSource: 'incoming',
    statusBefore: 'Incomplete',
    statusAfter: 'Incomplete',
    progressBefore: 'WaitingForAnswer',
    progressAfter: 'CandidateResponded',
    classificationCounts: {
      substantive_answer: 1,
      arbitrary_provider_key: 99,
    },
    retryable: false,
    interviewId: 'secret-interview-id',
    claimToken: 'secret-claim-token',
    transcript: 'secret transcript',
  });
  assert.deepEqual(log.classification_counts, { substantive_answer: 1 });
  assert.equal(Object.hasOwn(log, 'interviewId'), false);
  assert.equal(Object.hasOwn(log, 'claimToken'), false);
  assert.equal(Object.hasOwn(log, 'transcript'), false);
  assert.doesNotMatch(JSON.stringify(log), /secret|arbitrary_provider_key/);
});

test('serialization migration is additive and least-privilege at the source boundary', () => {
  const migrationPath = path.join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260724142720_final_transcript_reconciliation_serialization.sql',
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(
    migration,
    /create table if not exists private\.interview_final_transcript_reconciliation_claims/,
  );
  assert.equal(
    (migration.match(/create or replace function public\.(?:claim|finalize|release)_interview_final_transcript_reconciliation/g) || []).length,
    3,
  );
  assert.match(
    migration,
    /create or replace function public\.persist_interview_unanswered_questions_if_authoritative/,
  );
  assert.match(
    migration,
    /create or replace function private\.is_valid_interview_unanswered_questions/,
  );
  assert.match(
    migration,
    /create or replace function private\.is_valid_interview_analysis_v2/,
  );
  assert.match(
    migration,
    /create or replace function private\.is_valid_interview_transcript_scores/,
  );
  assert.equal(
    (migration.match(/create or replace function public\.(?:claim|finalize|release)_interview_analysis_v2/g) || []).length,
    3,
  );
  assert.equal((migration.match(/\nsecurity definer\nset search_path = ''/g) || []).length, 7);
  assert.match(
    migration,
    /alter table private\.interview_final_transcript_reconciliation_claims force row level security/,
  );
  assert.match(
    migration,
    /revoke all on table private\.interview_final_transcript_reconciliation_claims\s+from public, anon, authenticated, service_role/,
  );
  assert.equal(
    (migration.match(/grant execute on function public\.(?:claim|finalize|release)_interview_final_transcript_reconciliation/g) || []).length,
    3,
  );
  assert.match(
    migration,
    /grant execute on function public\.persist_interview_unanswered_questions_if_authoritative\(\s*uuid, bigint, text, jsonb\s*\) to service_role/,
  );
  assert.equal(
    (migration.match(/grant execute on function public\.(?:claim|finalize|release)_interview_analysis_v2/g) || []).length,
    3,
  );
  assert.match(
    migration,
    /revoke all on function private\.is_valid_interview_analysis_v2\(jsonb\)\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /revoke all on function private\.is_valid_interview_transcript_scores\(jsonb\)\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(migration, /\bexecute\s+(?:format|\()/i);
  assert.doesNotMatch(migration, /\b(?:insert\s+into|update|delete\s+from)\s+public\.(?:reports|interview_reset_events|interview_adjudications|interview_admin_audit_logs)/i);
});

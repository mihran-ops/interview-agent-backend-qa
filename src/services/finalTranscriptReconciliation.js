'use strict';

const CLASSIFICATION_KEYS = Object.freeze([
  'acknowledgment',
  'repeat_request',
  'hearing_or_audio_issue',
  'clarification_request',
  'filler',
  'silence_or_empty',
  'unknown_non_substantive',
  'substantive_answer',
]);

const SNAPSHOT_KEYS = new Set([
  'has_substantive_response',
  'substantive_response_count',
  'candidate_utterance_count',
  'candidate_word_count',
  'classification_counts',
  'conversation_progress_state',
]);

const LEGACY_SNAPSHOT_KEYS = new Set([
  'has_substantive_response',
  'substantive_response_count',
  'candidate_utterance_count',
  'classification_counts',
  'conversation_progress_state',
]);

const TRANSCRIPT_SCORE_KEYS = Object.freeze([
  'overall',
  'role_fit',
  'technical_strength',
  'communication_quality',
  'confidence',
  'ai_aided_risk',
  'ai_aided_risk_reason',
]);
const TRANSCRIPT_PRIMARY_SCORE_KEYS = Object.freeze([
  'overall',
  'role_fit',
  'technical_strength',
  'communication_quality',
]);
const TRANSCRIPT_SCORE_KEY_SET = new Set(TRANSCRIPT_SCORE_KEYS);
const TRANSCRIPT_AI_AIDED_RISK_VALUES = new Set(['low', 'medium', 'high']);
const MAX_TRANSCRIPT_SCORE_JSON_BYTES = 16384;
const MAX_TRANSCRIPT_SCORE_REASON_CHARACTERS = 300;

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2147483647;
}

function isPostgresSafeUnicodeText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateTranscriptScores(scores) {
  if (!scores ||
      typeof scores !== 'object' ||
      Array.isArray(scores) ||
      Object.getPrototypeOf(scores) !== Object.prototype) {
    return { valid: false, category: 'invalid_type' };
  }

  const ownKeys = Reflect.ownKeys(scores);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return { valid: false, category: 'invalid_type' };
  }
  for (const key of TRANSCRIPT_SCORE_KEYS) {
    if (!ownKeys.includes(key)) return { valid: false, category: 'missing_key' };
  }
  for (const key of ownKeys) {
    if (!TRANSCRIPT_SCORE_KEY_SET.has(key)) {
      return { valid: false, category: 'unknown_key' };
    }
  }

  const descriptors = Object.getOwnPropertyDescriptors(scores);
  for (const key of TRANSCRIPT_SCORE_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return { valid: false, category: 'invalid_type' };
    }
  }

  const primaryValues = TRANSCRIPT_PRIMARY_SCORE_KEYS.map(
    (key) => descriptors[key].value,
  );
  const nullPrimaryCount = primaryValues.filter((value) => value === null).length;
  if (nullPrimaryCount !== 0 && nullPrimaryCount !== primaryValues.length) {
    return { valid: false, category: 'invalid_type' };
  }

  const numericValues = nullPrimaryCount === primaryValues.length
    ? []
    : primaryValues;
  const confidence = descriptors.confidence.value;
  if (confidence !== null) numericValues.push(confidence);
  for (const value of numericValues) {
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value)) {
      return { valid: false, category: 'invalid_type' };
    }
    if (value < 0 || value > 100) {
      return { valid: false, category: 'out_of_range' };
    }
  }

  const risk = descriptors.ai_aided_risk.value;
  if (typeof risk !== 'string') {
    return { valid: false, category: 'invalid_type' };
  }
  if (!TRANSCRIPT_AI_AIDED_RISK_VALUES.has(risk)) {
    return { valid: false, category: 'invalid_enum' };
  }

  const reason = descriptors.ai_aided_risk_reason.value;
  if (typeof reason !== 'string' ||
      reason !== reason.trim() ||
      !isPostgresSafeUnicodeText(reason)) {
    return { valid: false, category: 'invalid_type' };
  }

  let serialized;
  try {
    serialized = JSON.stringify(scores);
  } catch {
    return { valid: false, category: 'invalid_type' };
  }
  if (typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > MAX_TRANSCRIPT_SCORE_JSON_BYTES ||
      [...reason].length > MAX_TRANSCRIPT_SCORE_REASON_CHARACTERS) {
    return { valid: false, category: 'oversized' };
  }

  return { valid: true };
}

function allowedClassificationCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, count] of Object.entries(value)) {
    if (!CLASSIFICATION_KEYS.includes(key) || !isNonNegativeInteger(count)) return null;
    if (count > 0) out[key] = count;
  }
  return out;
}

function buildEvidenceSnapshot(evidence) {
  const counts = allowedClassificationCounts(evidence?.counts);
  if (counts === null) throw new Error('invalid_classification_counts');
  const candidateUtteranceCount = evidence?.candidateUtteranceCount;
  const substantiveResponseCount = evidence?.substantiveResponseCount;
  const candidateWordCount = Array.isArray(evidence?.utterances)
    ? evidence.utterances.reduce((sum, utterance) => {
      if (!isNonNegativeInteger(utterance?.wordCount)) throw new Error('invalid_candidate_word_count');
      return sum + utterance.wordCount;
    }, 0)
    : 0;
  const snapshot = {
    has_substantive_response: substantiveResponseCount > 0,
    substantive_response_count: substantiveResponseCount,
    candidate_utterance_count: candidateUtteranceCount,
    candidate_word_count: candidateWordCount,
    classification_counts: counts,
    conversation_progress_state: substantiveResponseCount > 0
      ? 'CandidateResponded'
      : 'NoSubstantiveCandidateResponse',
  };
  const validation = validateEvidenceSnapshot(snapshot);
  if (!validation.ok) throw new Error(validation.reason);
  return snapshot;
}

function validateEvidenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, reason: 'invalid_snapshot_object' };
  }
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEYS.has(key)) return { ok: false, reason: 'unknown_snapshot_key' };
  }
  for (const key of SNAPSHOT_KEYS) {
    if (!Object.hasOwn(snapshot, key)) return { ok: false, reason: 'invalid_snapshot_missing_key' };
  }
  if (typeof snapshot.has_substantive_response !== 'boolean') {
    return { ok: false, reason: 'invalid_substantive_boolean' };
  }
  for (const key of [
    'substantive_response_count',
    'candidate_utterance_count',
    'candidate_word_count',
  ]) {
    if (!isNonNegativeInteger(snapshot[key])) return { ok: false, reason: `invalid_${key}` };
  }
  const counts = allowedClassificationCounts(snapshot.classification_counts);
  if (counts === null) return { ok: false, reason: 'unknown_or_invalid_classification_count' };
  const classificationTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (classificationTotal !== snapshot.candidate_utterance_count) {
    return { ok: false, reason: 'classification_count_mismatch' };
  }
  if ((counts.substantive_answer || 0) !== snapshot.substantive_response_count) {
    return { ok: false, reason: 'substantive_count_mismatch' };
  }
  if (snapshot.substantive_response_count > snapshot.candidate_utterance_count) {
    return { ok: false, reason: 'incoherent_substantive_count' };
  }
  if (snapshot.has_substantive_response !== (snapshot.substantive_response_count > 0)) {
    return { ok: false, reason: 'incoherent_substantive_boolean' };
  }
  const expectedProgress = snapshot.has_substantive_response
    ? 'CandidateResponded'
    : 'NoSubstantiveCandidateResponse';
  if (snapshot.conversation_progress_state !== expectedProgress) {
    return { ok: false, reason: 'incoherent_progress_state' };
  }
  return { ok: true, reason: null };
}

function validateLegacyEvidenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, reason: 'invalid_legacy_snapshot_object' };
  }
  for (const key of Object.keys(snapshot)) {
    if (!LEGACY_SNAPSHOT_KEYS.has(key)) {
      return { ok: false, reason: 'unknown_legacy_snapshot_key' };
    }
  }
  for (const key of LEGACY_SNAPSHOT_KEYS) {
    if (!Object.hasOwn(snapshot, key)) {
      return { ok: false, reason: 'invalid_legacy_snapshot_missing_key' };
    }
  }
  if (typeof snapshot.has_substantive_response !== 'boolean') {
    return { ok: false, reason: 'invalid_legacy_substantive_boolean' };
  }
  for (const key of ['substantive_response_count', 'candidate_utterance_count']) {
    if (!isNonNegativeInteger(snapshot[key])) {
      return { ok: false, reason: `invalid_legacy_${key}` };
    }
  }
  const counts = allowedClassificationCounts(snapshot.classification_counts);
  if (counts === null) {
    return { ok: false, reason: 'unknown_or_invalid_legacy_classification_count' };
  }
  const classificationTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (classificationTotal !== snapshot.candidate_utterance_count) {
    return { ok: false, reason: 'legacy_classification_count_mismatch' };
  }
  if ((counts.substantive_answer || 0) !== snapshot.substantive_response_count) {
    return { ok: false, reason: 'legacy_substantive_count_mismatch' };
  }
  if (snapshot.substantive_response_count > snapshot.candidate_utterance_count) {
    return { ok: false, reason: 'incoherent_legacy_substantive_count' };
  }
  if (snapshot.has_substantive_response !== (snapshot.substantive_response_count > 0)) {
    return { ok: false, reason: 'incoherent_legacy_substantive_boolean' };
  }
  const expectedProgress = snapshot.has_substantive_response
    ? 'CandidateResponded'
    : 'NoSubstantiveCandidateResponse';
  if (snapshot.conversation_progress_state !== expectedProgress) {
    return { ok: false, reason: 'incoherent_legacy_progress_state' };
  }
  return { ok: true, reason: null };
}

function strengthTuple(snapshot) {
  return [
    snapshot.has_substantive_response ? 1 : 0,
    snapshot.substantive_response_count,
    snapshot.candidate_utterance_count,
    snapshot.candidate_word_count,
  ];
}

function compareEvidenceSnapshots(left, right) {
  const leftValidation = validateEvidenceSnapshot(left);
  const rightValidation = validateEvidenceSnapshot(right);
  if (!leftValidation.ok) throw new Error(leftValidation.reason);
  if (!rightValidation.ok) throw new Error(rightValidation.reason);
  const leftStrength = strengthTuple(left);
  const rightStrength = strengthTuple(right);
  for (let index = 0; index < leftStrength.length; index += 1) {
    if (leftStrength[index] > rightStrength[index]) return 1;
    if (leftStrength[index] < rightStrength[index]) return -1;
  }
  return 0;
}

function compareLegacyCurrentEvidence(currentLegacySnapshot, incomingSnapshot) {
  const currentValidation = validateLegacyEvidenceSnapshot(currentLegacySnapshot);
  const incomingValidation = validateEvidenceSnapshot(incomingSnapshot);
  if (!currentValidation.ok) throw new Error(currentValidation.reason);
  if (!incomingValidation.ok) throw new Error(incomingValidation.reason);
  const currentStrength = [
    currentLegacySnapshot.has_substantive_response ? 1 : 0,
    currentLegacySnapshot.substantive_response_count,
    currentLegacySnapshot.candidate_utterance_count,
  ];
  const incomingStrength = strengthTuple(incomingSnapshot).slice(0, 3);
  for (let index = 0; index < currentStrength.length; index += 1) {
    if (currentStrength[index] > incomingStrength[index]) return 1;
    if (currentStrength[index] < incomingStrength[index]) return -1;
  }
  return 0;
}

function selectAuthoritativeSnapshot({
  currentSnapshot,
  currentTranscriptHash,
  incomingSnapshot,
  incomingTranscriptHash,
}) {
  if (!currentSnapshot) {
    return { source: 'incoming', snapshot: incomingSnapshot, reason: 'no_current_snapshot' };
  }
  const comparison = compareEvidenceSnapshots(currentSnapshot, incomingSnapshot);
  if (comparison > 0) {
    return { source: 'current', snapshot: currentSnapshot, reason: 'stronger_current_snapshot' };
  }
  if (comparison < 0) {
    return { source: 'incoming', snapshot: incomingSnapshot, reason: 'stronger_incoming_snapshot' };
  }
  if (currentTranscriptHash && currentTranscriptHash === incomingTranscriptHash) {
    return { source: 'current', snapshot: currentSnapshot, reason: 'identical_transcript_hash' };
  }
  return {
    source: 'current',
    snapshot: currentSnapshot,
    reason: 'equal_strength_existing_authoritative',
  };
}

function boundedText(value, allowlist) {
  const text = typeof value === 'string' ? value : null;
  return text && allowlist.has(text) ? text : null;
}

function projectReconciliationLog(input = {}) {
  const counts = {};
  const sourceCounts = input.classificationCounts;
  if (sourceCounts && typeof sourceCounts === 'object' && !Array.isArray(sourceCounts)) {
    for (const key of CLASSIFICATION_KEYS) {
      const count = sourceCounts[key];
      if (isNonNegativeInteger(count) && count > 0) counts[key] = count;
    }
  }
  return {
    outcome: boundedText(input.outcome, new Set([
      'claimed',
      'recovered_expired_claim',
      'already_reconciled',
      'superseded_by_stronger_evidence',
      'busy',
      'invalid_snapshot',
      'binding_not_found',
      'finalized',
      'released',
      'already_released',
      'claim_mismatch',
      'already_completed',
      'failed',
    ])),
    claim_version: isNonNegativeInteger(input.claimVersion) ? input.claimVersion : null,
    scoring_performed: input.scoringPerformed === true,
    canonical_repair_applied: input.canonicalRepair === true,
    authoritative_snapshot_source: boundedText(
      input.authoritativeSnapshotSource,
      new Set(['incoming', 'current', 'existing_authoritative']),
    ),
    status_before: typeof input.statusBefore === 'string' ? input.statusBefore.slice(0, 80) : null,
    status_after: typeof input.statusAfter === 'string' ? input.statusAfter.slice(0, 80) : null,
    progress_before: typeof input.progressBefore === 'string' ? input.progressBefore.slice(0, 80) : null,
    progress_after: typeof input.progressAfter === 'string' ? input.progressAfter.slice(0, 80) : null,
    classification_counts: counts,
    retryable: input.retryable === true,
  };
}

module.exports = {
  CLASSIFICATION_KEYS,
  buildEvidenceSnapshot,
  compareEvidenceSnapshots,
  compareLegacyCurrentEvidence,
  projectReconciliationLog,
  selectAuthoritativeSnapshot,
  validateEvidenceSnapshot,
  validateLegacyEvidenceSnapshot,
  validateTranscriptScores,
};

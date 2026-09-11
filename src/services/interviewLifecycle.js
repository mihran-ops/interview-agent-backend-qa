'use strict';

const ACTIVE_ATTEMPT_STATUSES = new Set(['authorized', 'starting', 'pending', 'started', 'connected', 'in_progress', 'ending_requested']);
const COMPLETED_ATTEMPT_STATUSES = new Set(['completed', 'complete', 'analyzed']);

function normalizedStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isActiveAttempt(status) {
  return ACTIVE_ATTEMPT_STATUSES.has(normalizedStatus(status));
}

function isCompletedAttempt(status) {
  return COMPLETED_ATTEMPT_STATUSES.has(normalizedStatus(status));
}

function candidateHasPermanentCompletion(candidate, attempts) {
  const candidateText = `${candidate?.status || ''} ${candidate?.interview_status || ''}`.toLowerCase();
  if (candidateText.includes('interview completed')) return { blocked: true, code: 'completed_interview_retake_blocked' };
  for (const attempt of attempts || []) {
    if (isCompletedAttempt(attempt?.status) && attempt?.has_substantive_response === true) {
      return { blocked: true, code: 'completed_interview_retake_blocked' };
    }
    if (isCompletedAttempt(attempt?.status) && attempt?.has_substantive_response == null) {
      return { blocked: true, code: 'candidate_interview_state_requires_review' };
    }
  }
  return { blocked: false, code: null };
}

function evaluateReplacementEligibility({ candidate, attempts, resetEvents } = {}) {
  const all = Array.isArray(attempts) ? attempts : [];
  const permanent = candidateHasPermanentCompletion(candidate, all);
  if (permanent.blocked) return { eligible: false, code: permanent.code };
  if (all.some((attempt) => isActiveAttempt(attempt?.status) || attempt?.is_active === true)) {
    return { eligible: false, code: 'active_interview_attempt_exists' };
  }
  if ((resetEvents || []).length) return { eligible: false, code: 'replacement_already_used' };
  const latest = [...all].sort((a, b) => Number(b.attempt_number || 0) - Number(a.attempt_number || 0))[0];
  if (!latest) return { eligible: false, code: 'replacement_not_authorized' };
  const status = normalizedStatus(latest.status);
  const eligibleStatus = ['incomplete', 'failed', 'disconnected'].includes(status)
    || (['ended', 'transcriptionreceived'].includes(status) && latest.has_substantive_response === false)
    || latest.retryable === true || latest.replacement_eligible === true;
  if (!eligibleStatus) {
    return { eligible: false, code: latest.has_substantive_response == null ? 'candidate_interview_state_requires_review' : 'interview_reset_not_eligible' };
  }
  return { eligible: true, code: null, latestAttemptId: latest.id };
}

function transcriptCompletionTransition(evidence) {
  if (evidence?.ok) {
    return { status: 'ReadyForAnalysis', failure_code: null, retryable: false, replacement_eligible: false };
  }
  return {
    status: 'Incomplete',
    failure_code: 'NO_SUBSTANTIVE_CANDIDATE_RESPONSE',
    failure_stage: 'transcript_evidence_gate',
    failure_summary: 'Interview ended before a substantive candidate response was recorded.',
    retryable: true,
    replacement_eligible: true,
  };
}

module.exports = {
  ACTIVE_ATTEMPT_STATUSES,
  COMPLETED_ATTEMPT_STATUSES,
  normalizedStatus,
  isActiveAttempt,
  isCompletedAttempt,
  candidateHasPermanentCompletion,
  evaluateReplacementEligibility,
  transcriptCompletionTransition,
};

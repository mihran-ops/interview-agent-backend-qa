'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_PROCESSING_MS = 2 * 60 * 1000;

class CandidateSubmissionKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandidateSubmissionKeyError';
    this.code = 'INVALID_SUBMISSION_KEY';
  }
}

function normalizeSubmissionKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  if (!UUID_RE.test(key)) throw new CandidateSubmissionKeyError('submission_key must be a UUID');
  return key;
}

async function reserveCandidateSubmission(db, { roleId, submissionKey }) {
  const key = normalizeSubmissionKey(submissionKey);
  if (!key) return { enabled: false };

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await db
    .from('candidate_submission_requests')
    .insert({ role_id: roleId, submission_key: key, status: 'processing', updated_at: now })
    .select('id,role_id,submission_key,status,candidate_id,response_status,response_body,updated_at')
    .maybeSingle();

  if (!insertError && inserted) return { enabled: true, state: 'acquired', row: inserted };
  if (insertError?.code !== '23505') throw insertError;

  const { data: existing, error: readError } = await db
    .from('candidate_submission_requests')
    .select('id,role_id,submission_key,status,candidate_id,response_status,response_body,updated_at')
    .eq('role_id', roleId)
    .eq('submission_key', key)
    .maybeSingle();
  if (readError || !existing) throw readError || new Error('candidate submission reservation missing');

  if (existing.status === 'completed' && existing.response_body) {
    return { enabled: true, state: 'replay', row: existing };
  }

  const updatedAtMs = Date.parse(existing.updated_at || '');
  const stale = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= STALE_PROCESSING_MS;
  if (existing.status === 'failed' || stale) {
    let claim = db
      .from('candidate_submission_requests')
      .update({ status: 'processing', response_status: null, response_body: null, last_error_code: null, updated_at: now })
      .eq('id', existing.id);
    claim = existing.status === 'failed'
      ? claim.eq('status', 'failed')
      : claim.eq('updated_at', existing.updated_at);
    const { data: claimed, error: claimError } = await claim
      .select('id,role_id,submission_key,status,candidate_id,response_status,response_body,updated_at')
      .maybeSingle();
    if (claimError) throw claimError;
    if (claimed) return { enabled: true, state: 'acquired', row: claimed };
  }

  return { enabled: true, state: 'processing', row: existing };
}

async function completeCandidateSubmission(db, reservation, { status, body, candidateId = null }) {
  if (!reservation?.enabled || !reservation?.row?.id) return;
  const { error } = await db
    .from('candidate_submission_requests')
    .update({
      status: 'completed',
      candidate_id: candidateId || reservation.row.candidate_id || null,
      response_status: status,
      response_body: body,
      last_error_code: body?.code || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', reservation.row.id);
  if (error) throw error;
}

async function failCandidateSubmission(db, reservation, { code, candidateId = null }) {
  if (!reservation?.enabled || !reservation?.row?.id) return;
  const { error } = await db
    .from('candidate_submission_requests')
    .update({
      status: 'failed',
      candidate_id: candidateId || reservation.row.candidate_id || null,
      last_error_code: code || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', reservation.row.id);
  if (error) throw error;
}

module.exports = {
  CandidateSubmissionKeyError,
  normalizeSubmissionKey,
  reserveCandidateSubmission,
  completeCandidateSubmission,
  failCandidateSubmission
};

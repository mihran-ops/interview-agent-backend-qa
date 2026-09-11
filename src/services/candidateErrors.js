'use strict';

const ERROR_DEFINITIONS = Object.freeze({
  CANDIDATE_ALREADY_EXISTS: {
    status: 409,
    error: 'candidate_already_exists',
    detail: 'A candidate with this contact information already exists for this role. Use the original information or contact support.'
  },
  INTERVIEW_ALREADY_COMPLETED: {
    status: 409,
    error: 'interview_already_completed',
    detail: 'An interview has already been completed for this role. Contact support if another attempt was approved.'
  },
  INTERVIEW_IN_PROGRESS: {
    status: 409,
    error: 'interview_in_progress',
    detail: 'An interview is already in progress for this role. Return to the existing interview session.'
  },
  RETAKE_AUTHORIZATION_REQUIRED: {
    status: 409,
    error: 'retake_authorization_required',
    detail: 'A new interview attempt requires approval. Contact support to request another attempt.'
  },
  INTERVIEW_LINK_EXPIRED: {
    status: 404,
    error: 'interview_link_expired',
    detail: 'This interview link is invalid or expired. Request a current link from the hiring team.'
  },
  INTERVIEW_LINK_RESET_REQUIRED: {
    status: 409,
    error: 'interview_link_reset_required',
    detail: 'This interview link can no longer be used. Contact support to request reviewed access.'
  },
  OTP_EXPIRED: {
    status: 400,
    error: 'otp_expired',
    detail: 'This verification code has expired. Request a new code and try again.'
  },
  OTP_USED: {
    status: 400,
    error: 'otp_used',
    detail: 'This verification code has already been used. Request a new code and try again.'
  },
  STALE_ACCESS_INVALIDATED: {
    status: 409,
    error: 'stale_access_invalidated',
    detail: 'This access code has been invalidated. Use the latest reset email.'
  },
  INVALID_PHONE_FOR_COUNTRY: {
    status: 400,
    error: 'invalid_phone_for_country',
    detail: 'Enter a valid phone number for the selected country.'
  },
  SMS_CHANNEL_UNAVAILABLE: {
    status: 503,
    error: 'sms_channel_unavailable',
    detail: 'Text message verification is not available. Choose Email to continue.',
    retryable: false
  },
  RESUME_EMPTY: {
    status: 400,
    error: 'resume_empty',
    detail: 'The resume appears to be blank. Choose a resume with readable content and try again.'
  },
  RESUME_UPLOAD_FAILED: {
    status: 503,
    error: 'resume_upload_failed',
    detail: 'The resume could not be uploaded. Your submission was not completed; please try again.'
  },
  RESUME_UNREADABLE: {
    status: 400,
    error: 'resume_unreadable',
    detail: 'The resume file could not be read. Choose a valid PDF, DOC, or DOCX file and try again.'
  },
  INTERVIEW_VENDOR_START_FAILED: {
    status: 502,
    error: 'interview_vendor_start_failed',
    detail: 'The interview room could not be started. Contact support before trying again.'
  },
  INTERVIEW_DURATION_NOT_CONFIGURED: {
    status: 503,
    error: 'interview_duration_not_configured',
    detail: 'Interview duration is not configured. Please contact the hiring team.',
    retryable: false
  },
  INTERVIEW_PROGRESS_STALLED: {
    status: 409,
    error: 'interview_progress_stalled',
    detail: 'The interview stopped progressing after a reconnect attempt. Contact support so your access can be reviewed.'
  },
  INTERVIEW_DISCONNECTED: {
    status: 409,
    error: 'interview_disconnected',
    detail: 'The interview disconnected and could not reconnect. Contact support so your access can be reviewed.'
  },
  ANALYSIS_FAILED: {
    status: 500,
    error: 'analysis_failed',
    detail: 'Interview analysis could not be completed. Support can retry the analysis without repeating the interview.'
  },
  INVALID_SUBMISSION_KEY: {
    status: 400,
    error: 'invalid_submission_key',
    detail: 'The submission session is invalid. Refresh the interview link and try again.'
  },
  RATE_LIMITED: {
    status: 429,
    error: 'rate_limited',
    detail: 'Too many requests. Please wait and try again.'
  },
  TEMPORARY_SERVICE_ERROR: {
    status: 503,
    error: 'temporary_service_error',
    detail: 'The service is temporarily unavailable. Please try again shortly.'
  }
});

function buildCandidateError(code, overrides = {}) {
  const definition = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.TEMPORARY_SERVICE_ERROR;
  const payload = {
    error: overrides.error || definition.error,
    code: ERROR_DEFINITIONS[code] ? code : 'TEMPORARY_SERVICE_ERROR',
    detail: overrides.detail || definition.detail,
    retryable: overrides.retryable ?? definition.retryable ?? definition.status >= 500
  };
  if (overrides.hint) payload.hint = overrides.hint;
  if (overrides.request_id) payload.request_id = overrides.request_id;
  return { status: overrides.status || definition.status, payload };
}

function sendCandidateError(res, code, overrides = {}) {
  const { status, payload } = buildCandidateError(code, overrides);
  return res.status(status).json(payload);
}

function getInterviewConflictCode(statusValue) {
  const status = String(statusValue || '').trim().toLowerCase();
  if (['analyzed', 'completed'].includes(status)) return 'INTERVIEW_ALREADY_COMPLETED';
  if (['starting', 'pending', 'started', 'connected', 'in_progress'].includes(status)) {
    return 'INTERVIEW_IN_PROGRESS';
  }
  return 'RETAKE_AUTHORIZATION_REQUIRED';
}

module.exports = {
  ERROR_DEFINITIONS,
  buildCandidateError,
  sendCandidateError,
  getInterviewConflictCode
};

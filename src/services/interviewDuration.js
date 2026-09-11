'use strict';

const MIN_INTERVIEW_MINUTES = 1;
const PROVIDER_MAX_CALL_DURATION_SECONDS = 3600;
const PROVIDER_CLOSING_GRACE_SECONDS = 20;
const MAX_INTERVIEW_MINUTES = Math.floor(
  (PROVIDER_MAX_CALL_DURATION_SECONDS - PROVIDER_CLOSING_GRACE_SECONDS) / 60
);

function validateConfiguredInterviewDuration(value) {
  if (value === undefined) return { ok: false, reason: 'missing_setting' };
  if (value === null) return { ok: false, reason: 'null_duration' };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'malformed_duration' };
  }
  if (!Number.isInteger(value)) return { ok: false, reason: 'non_integer_duration' };
  if (value < MIN_INTERVIEW_MINUTES) return { ok: false, reason: 'non_positive_duration' };
  if (value > MAX_INTERVIEW_MINUTES) return { ok: false, reason: 'duration_above_provider_limit' };
  return { ok: true, minutes: value };
}

function requireConfiguredInterviewDuration(value) {
  const validation = validateConfiguredInterviewDuration(value);
  if (validation.ok) return validation.minutes;

  throw durationConfigurationError(validation.reason);
}

function durationConfigurationError(reason) {
  const error = new Error('Interview duration configuration is invalid');
  error.code = 'INTERVIEW_DURATION_NOT_CONFIGURED';
  error.status = 503;
  error.retryable = false;
  error.failureCategory = 'definite_pre_acceptance';
  error.durationReason = reason;
  return error;
}

function resolveProviderMaxCallDurationSeconds(value) {
  const minutes = requireConfiguredInterviewDuration(value);
  const seconds = (minutes * 60) + PROVIDER_CLOSING_GRACE_SECONDS;
  if (seconds > PROVIDER_MAX_CALL_DURATION_SECONDS) {
    throw durationConfigurationError('duration_above_provider_limit');
  }
  return seconds;
}

module.exports = {
  MAX_INTERVIEW_MINUTES,
  MIN_INTERVIEW_MINUTES,
  PROVIDER_CLOSING_GRACE_SECONDS,
  PROVIDER_MAX_CALL_DURATION_SECONDS,
  requireConfiguredInterviewDuration,
  resolveProviderMaxCallDurationSeconds,
  validateConfiguredInterviewDuration,
};

'use strict';

const SENSITIVE_KEY_SUFFIX = 'x_alphascreen_otp_launch';

function normalizedKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isOtpLaunchTelemetryKey(value) {
  const key = normalizedKey(value);
  return key === SENSITIVE_KEY_SUFFIX || key.endsWith(`_${SENSITIVE_KEY_SUFFIX}`);
}

function redactOtpLaunchTelemetry(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (isOtpLaunchTelemetryKey(key)) {
      delete value[key];
      continue;
    }
    redactOtpLaunchTelemetry(value[key], seen);
  }
  return value;
}

module.exports = {
  isOtpLaunchTelemetryKey,
  redactOtpLaunchTelemetry,
};

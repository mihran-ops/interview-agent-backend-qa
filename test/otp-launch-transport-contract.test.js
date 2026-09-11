'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { redactOtpLaunchTelemetry } = require('../src/services/otpLaunchTelemetry');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('application CORS permits the dedicated OTP launch header', () => {
  assert.match(appSource, /['"]X-AlphaScreen-OTP-Launch['"]/);
});

test('Sentry removes the OTP launch header before event transport', () => {
  assert.match(appSource, /beforeSendTransaction\(event\)[\s\S]*redactOtpLaunchTelemetry\(event\)/);
  assert.match(appSource, /beforeSendSpan\(span\)[\s\S]*redactOtpLaunchTelemetry\(span\)/);
});

test('telemetry redaction removes request headers and Sentry semantic span attributes recursively', () => {
  const token = 'signed-launch-capability-must-not-leave-process';
  const event = {
    request: { headers: { 'X-AlphaScreen-OTP-Launch': token, accept: 'application/json' } },
    data: {
      'http.request.header.x_alphascreen_otp_launch': token,
      'http.response.status_code': 200,
    },
    spans: [{ data: { 'http.request.header.x-alphascreen-otp-launch': token, safe: 'kept' } }],
    contexts: { trace: { data: { 'HTTP Request Header X AlphaScreen OTP Launch': token } } },
  };
  redactOtpLaunchTelemetry(event);
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /signed-launch-capability|alphascreen.otp.launch/i);
  assert.equal(event.request.headers.accept, 'application/json');
  assert.equal(event.data['http.response.status_code'], 200);
  assert.equal(event.spans[0].data.safe, 'kept');
});

test('recovery migration uses a one-time database claim and service-role-only execution', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const migration = fs.readFileSync(
    path.join(migrationsDir, '20260903211201_otp_consumed_challenge_recovery_claim.sql'),
    'utf8',
  );
  assert.match(migration, /recovery_reissued_at/);
  assert.match(migration, /recovery_replacement_challenge_id/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /interval '60 seconds'/);
  assert.match(migration, /revoke all on function public\.service_claim_consumed_otp_recovery\(uuid,uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.service_claim_consumed_otp_recovery\(uuid,uuid\) to service_role/);
});

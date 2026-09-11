'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('candidate routes keep SMS owner-gated, consent-bound, and explicitly fallback-safe', () => {
  const submit = read('src/routes/public/candidateSubmit.js');
  const resend = read('src/routes/public/verifyOtp.js');
  const delivery = read('src/services/candidateSmsDelivery.js');
  for (const required of [
    'SMS_CANDIDATE_UI_ENABLED',
    'SMS_ENABLED',
    "['qa', 'production'].includes(environment)",
    "provider === 'telnyx'",
    'SMS_CONSENT_COPY_VERSION',
    'readSmsProductionControlConfig(env).valid',
    'readTelnyxLookupConfig(env).valid',
  ]) assert.match(delivery, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(delivery, /SMS_QA_DESTINATION_FINGERPRINT_ALLOWLIST/);
  assert.match(submit, /requestedOtpChannel === 'sms'/);
  assert.match(submit, /email_fallback_available/);
  assert.match(resend, /requestedChannel === 'sms'/);
  assert.match(resend, /requestedChannel.*email/s);
  assert.doesNotMatch(`${submit}\n${resend}`, /twilio_message_sid|telnyx_message_id|provider_message_id/);
});

test('QA/production and fake-provider safeguards come only from trusted environment and server controls', () => {
  const delivery = read('src/services/candidateSmsDelivery.js');
  assert.match(delivery, /provider === 'fake'.*environment === 'local'.*NODE_ENV/s);
  assert.match(delivery, /config\.provider === 'telnyx'[\s\S]*createSmsProductionControls/);
  assert.match(delivery, /configuredAdapter\.network === 'https' && \['qa', 'production'\]\.includes\(config\.environment\)/);
  assert.doesNotMatch(delivery, /req\.|request\.|body\./);
});

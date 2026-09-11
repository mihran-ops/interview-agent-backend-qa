'use strict';

const crypto = require('crypto');
const { EventWebhook } = require('@sendgrid/eventwebhook');

function cleanText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySignedWebhook({ publicKey, rawBody, signature, timestamp }) {
  if (!publicKey || !Buffer.isBuffer(rawBody) || !signature || !timestamp) return false;
  try {
    const verifier = new EventWebhook();
    const parsedKey = verifier.convertPublicKeyToECDSA(publicKey);
    return verifier.verifySignature(parsedKey, rawBody, signature, timestamp) === true;
  } catch (_) {
    return false;
  }
}

function authenticateSendgridWebhook({ env = process.env, getHeader, rawBody, querySecret }) {
  const publicKey = cleanText(env.SENDGRID_WEBHOOK_PUBLIC_KEY);
  if (publicKey) {
    const signature = cleanText(getHeader('x-twilio-email-event-webhook-signature'));
    const timestamp = cleanText(getHeader('x-twilio-email-event-webhook-timestamp'));
    const ok = verifySignedWebhook({ publicKey, rawBody, signature, timestamp });
    return ok
      ? { ok: true, mode: 'signature', status: 200, code: null }
      : { ok: false, mode: 'signature', status: 401, code: 'unauthorized' };
  }

  const configuredSecret = cleanText(env.SENDGRID_EVENT_WEBHOOK_SECRET);
  if (!configuredSecret) {
    return { ok: false, mode: 'misconfigured', status: 503, code: 'webhook_auth_not_configured' };
  }

  const providedSecret = cleanText(getHeader('x-sendgrid-webhook-secret')) || cleanText(querySecret);
  const ok = constantTimeEqual(providedSecret, configuredSecret);
  return ok
    ? { ok: true, mode: 'shared_secret', status: 200, code: null }
    : { ok: false, mode: 'shared_secret', status: 401, code: 'unauthorized' };
}

module.exports = {
  authenticateSendgridWebhook,
  constantTimeEqual,
  verifySignedWebhook,
};

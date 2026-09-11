'use strict';

const crypto = require('node:crypto');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TELNYX_EVENT_TYPES = new Set([
  'message.sent',
  'message.finalized',
  'message.received',
  'messaging-profile.spend-limit-reached',
]);
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_KEYWORDS = new Set(['START', 'UNSTOP']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

class TelnyxWebhookError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TelnyxWebhookError';
    this.code = code;
  }
}

function boundedOpaque(value, max = 255) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function createTelnyxPublicKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 4096 || /\u0000/.test(normalized)) throw new TelnyxWebhookError('misconfigured');
  try {
    if (normalized.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(normalized);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error('invalid key');
    const decoded = Buffer.from(normalized, 'base64');
    const der = decoded.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, decoded]) : decoded;
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new TelnyxWebhookError('misconfigured');
  }
}

function verifyTelnyxWebhook({ rawBody, signature, timestamp, publicKey, now = Date.now(), toleranceSeconds = 300 } = {}) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 256 * 1024) {
    throw new TelnyxWebhookError('invalid_body');
  }
  const signatureText = typeof signature === 'string' ? signature.trim() : '';
  const timestampText = typeof timestamp === 'string' ? timestamp.trim() : '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText) || !/^\d{10,13}$/.test(timestampText)) {
    throw new TelnyxWebhookError('invalid_signature');
  }
  const timestampSeconds = Number(timestampText);
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (!Number.isSafeInteger(timestampSeconds) || !Number.isFinite(nowSeconds)
      || Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new TelnyxWebhookError('stale_signature');
  }
  const signatureBytes = Buffer.from(signatureText, 'base64');
  if (signatureBytes.length !== 64) throw new TelnyxWebhookError('invalid_signature');
  const signedPayload = Buffer.concat([Buffer.from(`${timestampText}|`, 'utf8'), rawBody]);
  let verified = false;
  try {
    verified = crypto.verify(null, signedPayload, createTelnyxPublicKey(publicKey), signatureBytes);
  } catch (error) {
    if (error instanceof TelnyxWebhookError) throw error;
  }
  if (!verified) throw new TelnyxWebhookError('invalid_signature');
  return true;
}

function normalizeTelnyxDeliveryStatus(value) {
  switch (value) {
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'sending_failed':
      return 'failed';
    case 'delivery_failed':
    case 'delivery_unconfirmed':
      return 'undelivered';
    default:
      return null;
  }
}

function normalizeTelnyxControlAction(payload) {
  const automatic = String(payload?.autoresponse_type || '').trim().toUpperCase();
  const text = String(payload?.text || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const value = automatic || text;
  if (STOP_KEYWORDS.has(value)) return 'stop';
  if (START_KEYWORDS.has(value)) return 'start';
  if (HELP_KEYWORDS.has(value)) return 'help';
  return null;
}

function parseTelnyxWebhook(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new TelnyxWebhookError('invalid_json');
  }
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TelnyxWebhookError('invalid_event');
  const eventType = boundedOpaque(data.event_type, 80);
  const eventId = boundedOpaque(data.id);
  const occurredAt = new Date(data.occurred_at);
  if (!eventType || !eventId || data.record_type !== 'event' || !Number.isFinite(occurredAt.getTime())) {
    throw new TelnyxWebhookError('invalid_event');
  }
  if (!TELNYX_EVENT_TYPES.has(eventType)) return Object.freeze({ ignored: true, eventType });
  const payload = data.payload;

  if (eventType === 'message.received') {
    const action = normalizeTelnyxControlAction(payload);
    const fromE164 = String(payload?.from?.phone_number || '').trim();
    if (!action) return Object.freeze({ ignored: true, eventType });
    if (!/^\+[1-9]\d{7,14}$/.test(fromE164)) throw new TelnyxWebhookError('invalid_event');
    return Object.freeze({
      ignored: false,
      kind: 'control',
      provider: 'telnyx',
      eventId,
      occurredAt: occurredAt.toISOString(),
      eventType,
      action,
      fromE164,
    });
  }

  if (eventType === 'messaging-profile.spend-limit-reached') {
    return Object.freeze({
      ignored: false,
      kind: 'provider_breaker',
      provider: 'telnyx',
      eventId,
      occurredAt: occurredAt.toISOString(),
      eventType,
    });
  }

  const messageId = boundedOpaque(payload && payload.id);
  const recipients = payload && payload.to;
  if (!messageId || !Array.isArray(recipients) || recipients.length !== 1 || !recipients[0] || typeof recipients[0] !== 'object') {
    throw new TelnyxWebhookError('invalid_event');
  }
  const status = normalizeTelnyxDeliveryStatus(recipients[0].status);
  if (!status) return Object.freeze({ ignored: true, eventType });
  return Object.freeze({
    ignored: false,
    kind: 'delivery',
    provider: 'telnyx',
    messageId,
    eventId,
    occurredAt: occurredAt.toISOString(),
    status,
    eventType,
  });
}

module.exports = {
  TelnyxWebhookError,
  createTelnyxPublicKey,
  normalizeTelnyxControlAction,
  normalizeTelnyxDeliveryStatus,
  parseTelnyxWebhook,
  verifyTelnyxWebhook,
};

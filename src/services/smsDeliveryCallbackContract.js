'use strict';

const { SMS_DELIVERY_STATUSES } = require('./smsProviderContract');

const TERMINAL = new Set(['delivered', 'failed', 'undelivered', 'rejected']);
const TRANSITIONS = Object.freeze({
  queued: new Set(['queued', 'sent', 'delivered', 'failed', 'undelivered', 'rejected']),
  sent: new Set(['sent', 'delivered', 'failed', 'undelivered']),
  delivered: new Set(['delivered']),
  failed: new Set(['failed']),
  undelivered: new Set(['undelivered']),
  rejected: new Set(['rejected']),
});

function normalizeDeliveryCallbackFixture({ provider, messageId, eventId, status, occurredAt } = {}) {
  if (!/^[a-z0-9_-]{1,40}$/.test(String(provider || ''))) throw new TypeError('provider is invalid');
  for (const [name, value] of [['messageId', messageId], ['eventId', eventId]]) {
    if (!String(value || '').trim() || String(value).length > 255 || /[\u0000-\u001f\u007f]/.test(String(value))) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  if (!SMS_DELIVERY_STATUSES.includes(status)) throw new TypeError('status is invalid');
  if (!Number.isFinite(Date.parse(String(occurredAt || '')))) throw new TypeError('occurredAt is invalid');
  return Object.freeze({ provider, messageId, eventId, status, occurredAt: new Date(occurredAt).toISOString() });
}

function applyDeliveryStatusFixture(currentStatus, nextStatus) {
  if (!SMS_DELIVERY_STATUSES.includes(currentStatus) || !SMS_DELIVERY_STATUSES.includes(nextStatus)) {
    throw new TypeError('delivery status is invalid');
  }
  if (!TRANSITIONS[currentStatus].has(nextStatus)) return Object.freeze({ applied: false, status: currentStatus });
  return Object.freeze({ applied: true, status: nextStatus, terminal: TERMINAL.has(nextStatus) });
}

module.exports = { applyDeliveryStatusFixture, normalizeDeliveryCallbackFixture };

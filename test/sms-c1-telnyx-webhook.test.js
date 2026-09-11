'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { test } = require('node:test');

const { createTelnyxSmsWebhookRouter } = require('../src/routes/webhooks/telnyx');
const { parseTelnyxWebhook } = require('../src/services/telnyxWebhook');

const NOW_MS = Date.parse('2026-08-12T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function payload({ type = 'message.finalized', status = 'delivered', eventId = 'event-1', messageId = 'message-1' } = {}) {
  return Buffer.from(JSON.stringify({
    data: {
      record_type: 'event', id: eventId, event_type: type, occurred_at: '2026-08-12T12:00:00.000Z',
      payload: { id: messageId, to: [{ status }] },
    },
  }));
}

function controlPayload({ autoresponseType = 'STOP', text = 'stop', eventId = 'control-1', from = '+15555550100' } = {}) {
  return Buffer.from(JSON.stringify({
    data: {
      record_type: 'event', id: eventId, event_type: 'message.received', occurred_at: '2026-08-12T12:00:00.000Z',
      payload: { from: { phone_number: from }, text, autoresponse_type: autoresponseType },
    },
  }));
}

function spendLimitPayload() {
  return Buffer.from(JSON.stringify({
    data: {
      record_type: 'event', id: 'spend-event-1', event_type: 'messaging-profile.spend-limit-reached',
      occurred_at: '2026-08-12T12:00:00.000Z', payload: {},
    },
  }));
}

function signedHeaders(body, timestamp = TIMESTAMP) {
  return {
    'content-type': 'application/json',
    'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': crypto.sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), body]), privateKey).toString('base64'),
  };
}

async function serveAndPost({
  body,
  headers = {},
  recordDeliveryEvent,
  recordControlEvent,
  activateProviderBreaker,
  fingerprintDestination,
  env = { TELNYX_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY },
  logger,
} = {}) {
  const app = express();
  app.use('/webhook/telnyx/sms', express.raw({ type: 'application/json', limit: '256kb' }), createTelnyxSmsWebhookRouter({
    db: {}, env, now: () => NOW_MS, recordDeliveryEvent, recordControlEvent,
    activateProviderBreaker, fingerprintDestination, logger,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}/webhook/telnyx/sms`, { method: 'POST', headers, body });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('valid signed event is accepted and bound only by provider/message/event identifiers', async () => {
  const body = payload();
  let recorded = null;
  const response = await serveAndPost({
    body, headers: signedHeaders(body),
    recordDeliveryEvent: async (_db, value) => { recorded = value; return { found: true, applied: true, replayed: false }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(recorded, {
    provider: 'telnyx', providerMessageId: 'message-1', providerEventId: 'event-1',
    providerEventAt: '2026-08-12T12:00:00.000Z', deliveryStatus: 'delivered',
  });
});

test('signature failures are rejected before JSON parsing or mutation', async () => {
  for (const headers of [
    { 'content-type': 'application/json' },
    { 'content-type': 'application/json', 'telnyx-timestamp': TIMESTAMP, 'telnyx-signature-ed25519': 'not-base64!' },
    { ...signedHeaders(Buffer.from('{}')), 'content-type': 'application/json' },
  ]) {
    let called = false;
    const response = await serveAndPost({ body: Buffer.from('{not-json'), headers, recordDeliveryEvent: async () => { called = true; } });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  }
});

test('stale signed timestamp is rejected and missing key fails closed', async () => {
  const body = payload();
  const stale = String(Number(TIMESTAMP) - 301);
  assert.equal((await serveAndPost({ body, headers: signedHeaders(body, stale), recordDeliveryEvent: async () => ({}) })).status, 403);
  assert.equal((await serveAndPost({ body, headers: signedHeaders(body), env: {}, recordDeliveryEvent: async () => ({}) })).status, 503);
});

test('signed malformed JSON is rejected safely and unknown valid events are ignored', async () => {
  const malformed = Buffer.from('{not-json');
  assert.equal((await serveAndPost({ body: malformed, headers: signedHeaders(malformed), recordDeliveryEvent: async () => ({}) })).status, 400);
  const unknown = payload({ type: 'message.received' });
  let called = false;
  assert.equal((await serveAndPost({ body: unknown, headers: signedHeaders(unknown), recordDeliveryEvent: async () => { called = true; } })).status, 200);
  assert.equal(called, false);
});

test('known Telnyx statuses map to provider-neutral telemetry and invalid shapes fail closed', () => {
  const cases = [
    ['queued', 'queued'], ['sending', 'queued'], ['sent', 'sent'], ['delivered', 'delivered'],
    ['sending_failed', 'failed'], ['delivery_failed', 'undelivered'], ['delivery_unconfirmed', 'undelivered'],
  ];
  for (const [native, normalized] of cases) assert.equal(parseTelnyxWebhook(payload({ status: native })).status, normalized);
  assert.equal(parseTelnyxWebhook(payload({ status: 'unknown' })).ignored, true);
  assert.throws(() => parseTelnyxWebhook(Buffer.from(JSON.stringify({ data: { record_type: 'event', id: 'x', event_type: 'message.finalized', occurred_at: 'bad', payload: {} } }))));
});

test('signed STOP, START, and HELP events use fingerprint-only control storage', async () => {
  const actions = [];
  const fingerprintInputs = [];
  for (const action of ['STOP', 'START', 'HELP']) {
    const body = controlPayload({ autoresponseType: action, text: action.toLowerCase(), eventId: `control-${action}` });
    const response = await serveAndPost({
      body,
      headers: signedHeaders(body),
      fingerprintDestination: (value) => {
        fingerprintInputs.push(value);
        return 'b'.repeat(64);
      },
      recordControlEvent: async (_db, value) => {
        actions.push(value);
        return { applied: true, replayed: false, suppressed: value.action === 'stop', released: value.action === 'start' };
      },
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(actions.map((value) => value.action), ['stop', 'start', 'help']);
  assert.deepEqual(actions.map((value) => value.destinationFingerprint), Array(3).fill('b'.repeat(64)));
  assert.deepEqual(fingerprintInputs, Array(3).fill('+15555550100'));
  assert.equal(JSON.stringify(actions).includes('+15555550100'), false);
});

test('signed provider spend-limit event activates the global provider breaker', async () => {
  const body = spendLimitPayload();
  let breaker = null;
  const response = await serveAndPost({
    body,
    headers: signedHeaders(body),
    activateProviderBreaker: async (_db, value) => { breaker = value; return true; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(breaker, {
    provider: 'telnyx',
    providerEventId: 'spend-event-1',
    providerEventAt: '2026-08-12T12:00:00.000Z',
  });
});

test('unknown message, duplicate, and out-of-order results remain bounded acknowledgements', async () => {
  const cases = [
    { found: false, applied: false, replayed: false },
    { found: true, applied: false, replayed: true },
    { found: true, applied: false, replayed: false },
  ];
  for (const result of cases) {
    const body = payload();
    const response = await serveAndPost({ body, headers: signedHeaders(body), recordDeliveryEvent: async () => result });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test('callback logs contain only bounded metadata, never body, OTP, phone, key, or message ID', async () => {
  const body = payload({ messageId: '+15555550100', eventId: 'event-123456' });
  const logs = [];
  const response = await serveAndPost({
    body, headers: signedHeaders(body), logger: { info: (...args) => logs.push(args) },
    recordDeliveryEvent: async () => ({ found: true, applied: true, replayed: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(logs[0][1].provider_event_age_ms, 0);
  const encoded = JSON.stringify(logs);
  for (const forbidden of ['+15555550100', '123456', PUBLIC_KEY, body.toString('utf8'), 'message-1']) assert.equal(encoded.includes(forbidden), false);
});

test('application mounts raw Telnyx body before general JSON parsing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const webhook = source.indexOf("app.use('/webhook/telnyx/sms'");
  const json = source.indexOf('app.use(express.json');
  assert.ok(webhook >= 0 && json >= 0 && webhook < json);
  assert.match(source, /delete event\.request\.headers\['telnyx-signature-ed25519'\]/);
  assert.match(source, /delete event\.request\.headers\['telnyx-timestamp'\]/);
  assert.match(source, /webhook\\\/telnyx\\\/sms[\s\S]*delete event\.request\.data/);
});

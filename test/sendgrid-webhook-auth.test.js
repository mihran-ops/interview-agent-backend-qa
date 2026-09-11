'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authenticateSendgridWebhook,
  constantTimeEqual,
  verifySignedWebhook,
} = require('../src/services/sendgridWebhookAuth');

const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==';
const SIGNATURE = 'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=';
const TIMESTAMP = '1600112502';
const PAYLOAD = Buffer.from(JSON.stringify([
  {
    email: 'hello@world.com',
    event: 'dropped',
    reason: 'Bounced Address',
    sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
    sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0',
    'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>',
    timestamp: 1600112492,
  },
]) + '\r\n');

function headers(values = {}) {
  return (name) => values[String(name || '').toLowerCase()] || null;
}

test('valid SendGrid signed webhook authenticates against exact raw bytes', () => {
  assert.equal(verifySignedWebhook({
    publicKey: PUBLIC_KEY,
    rawBody: PAYLOAD,
    signature: SIGNATURE,
    timestamp: TIMESTAMP,
  }), true);

  const result = authenticateSendgridWebhook({
    env: { SENDGRID_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY },
    getHeader: headers({
      'x-twilio-email-event-webhook-signature': SIGNATURE,
      'x-twilio-email-event-webhook-timestamp': TIMESTAMP,
    }),
    rawBody: PAYLOAD,
    querySecret: 'obsolete-query-secret',
  });
  assert.deepEqual(result, { ok: true, mode: 'signature', status: 200, code: null });
});

test('signed mode rejects tampering and never falls back to the exposed query secret', () => {
  const result = authenticateSendgridWebhook({
    env: {
      SENDGRID_WEBHOOK_PUBLIC_KEY: PUBLIC_KEY,
      SENDGRID_EVENT_WEBHOOK_SECRET: 'obsolete-query-secret',
    },
    getHeader: headers({
      'x-twilio-email-event-webhook-signature': SIGNATURE,
      'x-twilio-email-event-webhook-timestamp': TIMESTAMP,
    }),
    rawBody: Buffer.concat([PAYLOAD, Buffer.from(' ')]),
    querySecret: 'obsolete-query-secret',
  });
  assert.deepEqual(result, { ok: false, mode: 'signature', status: 401, code: 'unauthorized' });
});

test('shared-secret authentication remains available only for the migration window', () => {
  const env = { SENDGRID_EVENT_WEBHOOK_SECRET: 'migration-secret' };
  assert.equal(authenticateSendgridWebhook({
    env,
    getHeader: headers({ 'x-sendgrid-webhook-secret': 'migration-secret' }),
    rawBody: PAYLOAD,
  }).ok, true);
  assert.equal(authenticateSendgridWebhook({
    env,
    getHeader: headers(),
    rawBody: PAYLOAD,
    querySecret: 'migration-secret',
  }).ok, true);
  assert.equal(constantTimeEqual('migration-secret', 'wrong-secret'), false);
});

test('webhook fails closed when no authentication method is configured', () => {
  assert.deepEqual(authenticateSendgridWebhook({
    env: {},
    getHeader: headers(),
    rawBody: PAYLOAD,
  }), {
    ok: false,
    mode: 'misconfigured',
    status: 503,
    code: 'webhook_auth_not_configured',
  });
});

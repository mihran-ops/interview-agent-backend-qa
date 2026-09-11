'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSmsMonitoringService,
  normalizeClientId,
  normalizeRange,
  runtimePosture,
} = require('../src/services/smsMonitoringService');

const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('range and client scope validation are bounded', () => {
  assert.equal(normalizeRange(), '7d');
  assert.equal(normalizeRange('24H'), '24h');
  assert.equal(normalizeClientId('all'), null);
  assert.equal(normalizeClientId(CLIENT_ID), CLIENT_ID);
  assert.throws(() => normalizeRange('90d'), (error) => error.code === 'invalid_sms_monitoring_range');
  assert.throws(() => normalizeClientId('not-a-client'), (error) => error.code === 'invalid_sms_monitoring_scope');
});

test('snapshot calls only aggregate service RPCs and adds safe runtime posture', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'service_get_sms_retention_snapshot') {
        return {
          data: {
            available: true,
            scheduled: true,
            schedule_utc: '25 3 * * *',
            last_completed_at: '2026-08-18T11:30:00.000Z',
            last_run_succeeded: true,
            last_scheduler_status: 'succeeded',
            last_counts: {},
          },
          error: null,
        };
      }
      return {
        data: {
          generated_at: '2026-08-18T12:00:00.000Z',
          delivery: { requested: 2, delivered: 1 },
          incidents: [],
        },
        error: null,
      };
    },
  };
  const env = {
    SMS_ENABLED: 'true',
    SMS_CANDIDATE_UI_ENABLED: 'true',
    SMS_ENVIRONMENT: 'qa',
    SMS_PROVIDER: 'telnyx',
    SMS_ALLOWED_COUNTRIES: 'US,invalid,PH',
    TELNYX_SENDER_E164: '+18335550123',
    TELNYX_API_KEY: 'secret-api-value',
    TELNYX_WEBHOOK_PUBLIC_KEY: 'secret-public-key-value',
    SMS_LOOKUP_ENABLED: 'true',
    SMS_LOOKUP_PROVIDER: 'telnyx',
    SMS_DAILY_SPEND_CAP_CENTS: '2500',
    SMS_ABUSE_HMAC_SECRET: 'secret-abuse-value',
    SMS_CONSENT_COPY_VERSION: 'sms-consent-v2',
    SMS_COMPLIANCE_REVIEW_STATUS: 'pending',
    SMS_COMPLIANCE_REVIEW_VERSION: 'review-2026-08',
    SMS_COMPLIANCE_REVIEWED_AT: '2026-08-18T11:00:00.000Z',
  };
  const now = () => new Date('2026-08-18T12:00:00.000Z');
  const service = createSmsMonitoringService({ db, env, now });
  const result = await service.snapshot({ range: '24h', client_id: CLIENT_ID });

  assert.deepEqual(calls, [
    [
      'service_get_sms_monitoring_snapshot',
      { p_since: '2026-08-17T12:00:00.000Z', p_client_id: CLIENT_ID },
    ],
    ['service_get_sms_retention_snapshot', undefined],
  ]);
  assert.equal(result.retention.scheduled, true);
  assert.equal(result.runtime.outbound_credentials_configured, true);
  assert.equal(result.runtime.delivery_webhook_signing_configured, true);
  assert.equal(result.runtime.inbound_webhook_signing_configured, true);
  assert.equal(result.runtime.inbound_webhook_secret_configured, true);
  assert.equal(result.runtime.compliance_review.legal_review_required, true);
  assert.deepEqual(result.runtime.allowed_countries, ['US', 'PH']);
  const serialized = JSON.stringify(result);
  for (const secret of [
    'secret-api-value',
    'secret-public-key-value',
    'secret-abuse-value',
    '+18335550123',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('runtime posture records approval only for explicit approved state', () => {
  assert.equal(runtimePosture({ SMS_COMPLIANCE_REVIEW_STATUS: 'approved' }).compliance_review.legal_review_required, false);
  assert.equal(runtimePosture({ SMS_COMPLIANCE_REVIEW_STATUS: 'made-up' }).compliance_review.status, 'not_recorded');
  assert.equal(runtimePosture({ SMS_DAILY_SPEND_CAP_CENTS: '-1' }).spend_cap_cents, null);
});

test('database failures and malformed snapshots map to a bounded service error', async () => {
  for (const response of [
    { data: null, error: { message: 'raw database detail' } },
    { data: null, error: null },
  ]) {
    const service = createSmsMonitoringService({
      db: {
        rpc: async (name) => name === 'service_get_sms_retention_snapshot'
          ? { data: { available: true }, error: null }
          : response,
      },
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    await assert.rejects(
      service.snapshot({}),
      (error) => error.code === 'sms_monitoring_unavailable' && !error.message.includes('raw database detail'),
    );
  }
});

test('retention snapshot failures and malformed data fail closed', async () => {
  for (const response of [
    { data: null, error: { message: 'raw retention detail' } },
    { data: null, error: null },
  ]) {
    const service = createSmsMonitoringService({
      db: {
        rpc: async (name) => name === 'service_get_sms_retention_snapshot'
          ? response
          : { data: { delivery: {}, incidents: [] }, error: null },
      },
      now: () => new Date('2026-08-18T12:00:00.000Z'),
    });
    await assert.rejects(
      service.snapshot({}),
      (error) => error.code === 'sms_monitoring_unavailable' && !error.message.includes('raw retention detail'),
    );
  }
});

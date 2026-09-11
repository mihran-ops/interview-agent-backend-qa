#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

let networkAttempts = 0;
function blockNetwork() {
  networkAttempts += 1;
  throw new Error('network disabled by SMS-C0 harness');
}
http.request = blockNetwork;
http.get = blockNetwork;
https.request = blockNetwork;
https.get = blockNetwork;
net.connect = blockNetwork;
net.createConnection = blockNetwork;
tls.connect = blockNetwork;
global.fetch = blockNetwork;

const { createFakeSmsProvider } = require('../src/services/smsFakeProvider');
const { orchestrateOtpSmsDelivery } = require('../src/services/smsDeliveryOrchestrator');

const MODES = [
  'accepted',
  'rejected',
  'transient_preacceptance',
  'ambiguous_outcome',
  'timeout_before_dispatch',
  'timeout_after_dispatch',
];
const NOW = new Date('2026-08-12T12:00:00.000Z');
const EXPECTED = Object.freeze({
  accepted: 'accepted',
  rejected: 'rejected',
  transient_preacceptance: 'transient_preacceptance',
  ambiguous_outcome: 'ambiguous_outcome',
  timeout_before_dispatch: 'transient_preacceptance',
  timeout_after_dispatch: 'ambiguous_outcome',
});

function uuidFor(index) {
  return `81000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function runCase(mode, index, candidate, suppressed = false) {
  const records = [];
  let issued = 0;
  const adapterMode = ['suppressed', 'ineligible'].includes(mode) ? 'accepted' : mode;
  const adapter = createFakeSmsProvider({ mode: adapterMode, environment: 'qa', now: () => NOW });
  const result = await orchestrateOtpSmsDelivery({
    db: {},
    environment: 'qa',
    candidate,
    destinationFingerprint: 'a'.repeat(64),
    authorizeAndBind: async () => ({ valid: true }),
    checkSuppressed: async () => suppressed,
    issueChallenge: async () => {
      issued += 1;
      return {
        challengeId: uuidFor(index), code: '123456',
        expiresAt: '2026-08-12T12:10:00.000Z', channel: 'sms', committed: true,
      };
    },
    adapter,
    recordMetadata: async (_db, record) => { records.push(record.event); return record; },
  });
  return Object.freeze({
    case: mode,
    outcome: result.outcome,
    adapter_calls: adapter.getCallCount(),
    challenge_issued: issued,
    metadata_events: records,
    retry_attempted: Boolean(result.retryAttempted),
    failover_attempted: Boolean(result.failoverAttempted),
  });
}

async function main() {
  if (process.argv[2] !== '--controlled-qa-harness') throw new Error('explicit controlled QA harness flag is required');
  const harnessEnvironment = String(process.env.SMS_ENVIRONMENT || '').toLowerCase();
  if (harnessEnvironment !== 'qa') throw new Error('fake harness requires an explicit QA environment');
  const candidate = { id: 'synthetic', phone_e164: '+15555550100', phone_country_code: 'US' };
  const results = [];
  for (let index = 0; index < MODES.length; index += 1) {
    results.push(await runCase(MODES[index], index + 1, candidate));
  }
  results.push(await runCase('suppressed', 20, candidate, true));
  results.push(await runCase('ineligible', 21, { id: 'synthetic', phone_e164: '+639171234567', phone_country_code: 'PH' }));

  for (const result of results) {
    const expected = EXPECTED[result.case] || (result.case === 'suppressed' ? 'blocked_destination' : 'invalid_destination');
    if (result.outcome !== expected) throw new Error(`unexpected bounded outcome for ${result.case}`);
  }
  if (networkAttempts !== 0) throw new Error('network attempt detected');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    harness: 'sms-c0-provider-neutral-fake',
    environment: harnessEnvironment,
    network_attempts: networkAttempts,
    sms_sent: 0,
    results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || 'harness failed').slice(0, 120) })}\n`);
  process.exitCode = 1;
});

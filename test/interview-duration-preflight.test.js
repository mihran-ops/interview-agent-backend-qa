'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { afterEach, test } = require('node:test');

const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const INTERVIEW_ID = '44444444-4444-4444-8444-444444444444';

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'createTavusInterview.js');
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js');
const handlerPath = path.join(__dirname, '..', 'src', 'services', 'tavusInterview.js');
const availabilityPath = path.join(__dirname, '..', 'src', 'services', 'roleInterviewAvailability.js');
const rateLimitPath = path.join(__dirname, '..', 'src', 'services', 'rateLimit.js');
const attemptsPath = path.join(__dirname, '..', 'src', 'services', 'interviewAttemptService.js');
const previousBillingMode = process.env.BILLING_MODE;
const previousInternalSyntheticClientIds = process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;
const previousTavusWebhookSecret = process.env.TAVUS_WEBHOOK_SECRET;
const TEST_TAVUS_WEBHOOK_SECRET = Buffer.alloc(32, 17).toString('base64url');
process.env.OTP_HMAC_SECRET_VERSION = '1';
process.env.OTP_HMAC_SECRET_V1 = Buffer.alloc(32, 23).toString('base64');
const {
  COOKIE_NAME: OTP_COOKIE_NAME,
  HEADER_NAME: OTP_HEADER_NAME,
  createOtpLaunchCapability,
} = require('../src/middleware/otpLaunchCapability');

const injectedPaths = [
  routePath,
  supabaseClientPath,
  handlerPath,
  availabilityPath,
  rateLimitPath,
  attemptsPath,
];

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function tableRows(db, table) {
  if (table === 'candidates') return [db.candidate];
  if (table === 'roles') return [db.role];
  if (table === 'clients') return [db.client];
  if (table === 'client_plan_settings') {
    return db.planSetting === undefined ? [] : [db.planSetting];
  }
  if (table === 'interviews') return db.interviews;
  return [];
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.updatePayload = null;
  }

  select() { return this; }
  limit() { return this; }

  eq(column, value) {
    this.filters.push([column, value]);
    return this;
  }

  update(payload) {
    this.updatePayload = payload;
    return this;
  }

  filteredRows() {
    return tableRows(this.db, this.table).filter((row) => (
      this.filters.every(([column, value]) => String(row?.[column] ?? '') === String(value ?? ''))
    ));
  }

  async maybeSingle() {
    if (this.table === 'client_plan_settings' && this.db.planError) {
      return { data: null, error: { code: 'SYNTHETIC_QUERY_ERROR', message: 'synthetic raw database error' } };
    }
    return { data: this.filteredRows()[0] || null, error: null };
  }

  async single() {
    return this.maybeSingle();
  }

  async execute() {
    const rows = this.filteredRows();
    if (this.updatePayload) {
      for (const row of rows) Object.assign(row, this.updatePayload);
      this.db.writes.push({ table: this.table, payload: this.updatePayload });
    }
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function createDatabase(planSetting, options = {}) {
  const db = {
    planSetting,
    planError: options.planError === true,
    candidate: {
      id: CANDIDATE_ID,
      role_id: ROLE_ID,
      client_id: CLIENT_ID,
      name: 'Synthetic Duration Candidate',
    },
    role: {
      id: ROLE_ID,
      client_id: CLIENT_ID,
      status: 'active',
      title: 'Synthetic Duration Role',
      tavus_document_id: 'synthetic-document',
    },
    client: {
      id: CLIENT_ID,
      billing_status: 'active',
      access_override_mode: options.accessOverrideMode || 'force_active',
      candidate_assistance_contact: '',
    },
    interviews: [{ id: INTERVIEW_ID }],
    writes: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
  return db;
}

async function startServer(planSetting, options = {}) {
  process.env.TAVUS_WEBHOOK_SECRET = TEST_TAVUS_WEBHOOK_SECRET;
  const db = createDatabase(planSetting, options);
  const calls = {
    claim: 0,
    provider: 0,
  };

  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db });
  injectModule(handlerPath, {
    createTavusInterviewHandler: async (_candidate, _role, _webhookUrl, options) => {
      calls.provider += 1;
      return {
        conversation_id: 'synthetic-conversation',
        conversation_url: 'https://example.invalid/synthetic-conversation',
        max_interview_minutes: options.maxInterviewMinutes,
      };
    },
  });
  injectModule(availabilityPath, {
    getRoleInterviewAvailability: async () => ({ remaining_interviews: 1 }),
    syncRoleInterviewLimitNotification: async () => {},
  });
  injectModule(rateLimitPath, {
    getRequestSubjectKey: () => 'synthetic-subject',
    checkAndIncrementRateLimit: async () => ({ allowed: true }),
  });
  injectModule(attemptsPath, {
    claimInterviewAttempt: async () => {
      calls.claim += 1;
      return {
        interview_id: INTERVIEW_ID,
        attempt_number: 1,
        start_claimed: true,
      };
    },
    completeRecoveryStart: async () => {},
    recordVendorBindingFailure: async () => {},
  });

  process.env.BILLING_MODE = 'enforce';
  if (options.internalSynthetic === true) process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS = CLIENT_ID;
  else delete process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;
  delete require.cache[routePath];
  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/create-tavus-interview', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    calls,
    db,
    server,
    url: `http://127.0.0.1:${server.address().port}/create-tavus-interview`,
  };
}

async function postStart(url, options = {}) {
  const origin = options.origin || '';
  const launchCapability = createOtpLaunchCapability({
    challenge_id: '55555555-5555-4555-8555-555555555555',
    candidate_id: CANDIDATE_ID,
    client_id: options.capabilityClientId || CLIENT_ID,
    role_id: ROLE_ID,
    request_origin: options.transport === 'header' ? origin : null,
  });
  const headers = { 'content-type': 'application/json' };
  if (options.transport === 'header') {
    headers[OTP_HEADER_NAME] = launchCapability;
    headers.origin = origin;
  } else {
    headers.cookie = `${OTP_COOKIE_NAME}=${encodeURIComponent(launchCapability)}`;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      candidate_id: CANDIDATE_ID,
      role_id: ROLE_ID,
    }),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

const servers = new Set();

afterEach(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  servers.clear();
  for (const filename of injectedPaths) delete require.cache[filename];
  if (previousBillingMode === undefined) delete process.env.BILLING_MODE;
  else process.env.BILLING_MODE = previousBillingMode;
  if (previousInternalSyntheticClientIds === undefined) delete process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;
  else process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS = previousInternalSyntheticClientIds;
  if (previousTavusWebhookSecret === undefined) delete process.env.TAVUS_WEBHOOK_SECRET;
  else process.env.TAVUS_WEBHOOK_SECRET = previousTavusWebhookSecret;
});

for (const [label, planSetting] of [
  ['missing row', undefined],
  ['null plan tier', { client_id: CLIENT_ID, plan_tier: null, max_interview_minutes: 10 }],
  ['unknown plan tier', { client_id: CLIENT_ID, plan_tier: 'unknown', max_interview_minutes: 10 }],
]) {
  test(`invalid ${label} fails closed before interview claim or provider creation`, async () => {
    const harness = await startServer(planSetting);
    servers.add(harness.server);

    const result = await postStart(harness.url);

    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'INTERVIEW_DURATION_NOT_CONFIGURED');
    assert.equal(result.body.detail, 'Interview duration is not configured. Please contact the hiring team.');
    assert.equal(result.body.retryable, false);
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.provider, 0);
    assert.deepEqual(harness.db.writes, []);
  });
}

test('force-active client without a direct duration remains blocked', async () => {
  const harness = await startServer(undefined, { accessOverrideMode: 'force_active' });
  servers.add(harness.server);

  const result = await postStart(harness.url);

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'INTERVIEW_DURATION_NOT_CONFIGURED');
  assert.equal(harness.calls.claim, 0);
  assert.equal(harness.calls.provider, 0);
});

test('duration lookup failure is retryable and does not masquerade as missing configuration', async () => {
  const harness = await startServer(undefined, {
    accessOverrideMode: 'force_active',
    planError: true,
  });
  servers.add(harness.server);

  const result = await postStart(harness.url);

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'TEMPORARY_SERVICE_ERROR');
  assert.equal(result.body.retryable, true);
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic raw database error/i);
  assert.equal(harness.calls.claim, 0);
  assert.equal(harness.calls.provider, 0);
});

test('a cross-site browser launch succeeds with only the origin-bound header capability', async () => {
  const harness = await startServer(
    { client_id: CLIENT_ID, plan_tier: 'pro', max_interview_minutes: 12 },
    { accessOverrideMode: 'force_active' },
  );
  servers.add(harness.server);

  const result = await postStart(harness.url, {
    transport: 'header',
    origin: 'https://candidate.example.test',
  });

  assert.equal(result.status, 200);
  assert.equal(harness.calls.claim, 1);
  assert.equal(harness.calls.provider, 1);
});

test('a header capability bound to another client fails before claim and provider work', async () => {
  const harness = await startServer(
    { client_id: CLIENT_ID, plan_tier: 'pro', max_interview_minutes: 12 },
    { accessOverrideMode: 'force_active' },
  );
  servers.add(harness.server);

  const result = await postStart(harness.url, {
    transport: 'header',
    origin: 'https://candidate.example.test',
    capabilityClientId: '66666666-6666-4666-8666-666666666666',
  });

  assert.equal(result.status, 400);
  assert.equal(harness.calls.claim, 0);
  assert.equal(harness.calls.provider, 0);
});

for (const [label, planTier, configuredDuration, expectedDuration, internalSynthetic] of [
  ['external Essential ignores stale stored duration', 'basic', 3, 10, false],
  ['external Pro uses the plan contract', 'pro', 3, 12, false],
  ['external Enterprise uses the plan contract', 'enterprise', 3, 15, false],
  ['three-minute internal QA fixture', 'basic', 3, 3, true],
  ['internal provider maximum with farewell headroom', 'enterprise', 59, 59, true],
]) {
  test(`valid ${label} preserves configured duration and normal launch`, async () => {
    const harness = await startServer(
      {
        client_id: CLIENT_ID,
        plan_tier: planTier,
        max_interview_minutes: configuredDuration,
      },
      { accessOverrideMode: 'force_active', internalSynthetic },
    );
    servers.add(harness.server);

    const result = await postStart(harness.url);

    assert.equal(result.status, 200);
    assert.equal(result.body.max_interview_minutes, expectedDuration);
    assert.equal(harness.calls.claim, 1);
    assert.equal(harness.calls.provider, 1);
  });
}

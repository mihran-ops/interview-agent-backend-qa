'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const ROLE_TOKEN = 'synthetic-role-token';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const previousInternalSyntheticClientIds = process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;

const routePath = path.join(__dirname, '..', 'routes', 'publicInterviewStatus.js');
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js');
const rateLimitPath = path.join(__dirname, '..', 'src', 'lib', 'rateLimit.js');

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
  }

  select() { return this; }
  eq() { return this; }

  async maybeSingle() {
    if (this.table === 'roles') {
      return {
        data: {
          id: ROLE_ID,
          client_id: CLIENT_ID,
          slug_or_token: ROLE_TOKEN,
          status: 'active',
        },
        error: null,
      };
    }
    if (this.table === 'client_plan_settings') {
      if (this.db.planError) {
        return { data: null, error: { message: 'synthetic raw query detail' } };
      }
      return { data: this.db.planSetting ?? null, error: null };
    }
    return { data: null, error: null };
  }
}

async function createHarness({ planSetting, planError = false, internalSynthetic = false }) {
  const db = {
    planSetting,
    planError,
    from(table) {
      return new FakeQuery(this, table);
    },
  };
  injectModule(supabaseClientPath, { supabase: db });
  injectModule(rateLimitPath, {
    getRequestSubjectKey: () => 'synthetic-subject',
    checkAndIncrementRateLimit: async () => ({ allowed: true }),
  });
  delete require.cache[routePath];
  if (internalSynthetic) process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS = CLIENT_ID;
  else delete process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;

  const app = express();
  app.use('/public', require(routePath));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/public/interview-status?role_token=${ROLE_TOKEN}`,
  };
}

const servers = new Set();

afterEach(async () => {
  for (const server of servers) {
    await new Promise((resolve) => server.close(resolve));
  }
  servers.clear();
  for (const filename of [routePath, supabaseClientPath, rateLimitPath]) {
    delete require.cache[filename];
  }
  if (previousInternalSyntheticClientIds === undefined) delete process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS;
  else process.env.INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS = previousInternalSyntheticClientIds;
});

test('public preflight returns the valid three-minute QA duration', async () => {
  const harness = await createHarness({
    planSetting: { client_id: CLIENT_ID, plan_tier: 'basic', max_interview_minutes: 3 },
    internalSynthetic: true,
  });
  servers.add(harness.server);

  const response = await fetch(harness.url);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.max_interview_minutes, 3);
});

test('public preflight ignores stale external duration and uses authoritative Essential capacity', async () => {
  const harness = await createHarness({
    planSetting: { client_id: CLIENT_ID, plan_tier: 'basic', max_interview_minutes: 60 },
  });
  servers.add(harness.server);

  const response = await fetch(harness.url);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.max_interview_minutes, 10);
});

test('public preflight exposes the stable bounded duration configuration error', async () => {
  const harness = await createHarness({ planSetting: null });
  servers.add(harness.server);

  const response = await fetch(harness.url);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, 'INTERVIEW_DURATION_NOT_CONFIGURED');
  assert.equal(body.detail, 'Interview duration is not configured. Please contact the hiring team.');
  assert.equal(body.retryable, false);
});

test('public preflight query errors remain retryable and sanitized', async () => {
  const harness = await createHarness({ planError: true });
  servers.add(harness.server);

  const response = await fetch(harness.url);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, 'TEMPORARY_SERVICE_ERROR');
  assert.equal(body.retryable, true);
  assert.doesNotMatch(JSON.stringify(body), /synthetic raw query detail/i);
});

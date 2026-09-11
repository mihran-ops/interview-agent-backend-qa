'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';

const {
  createTavusReadOnlyProvider,
} = require('../src/services/tavusVendorReconciliation');
const { createInterviewRecoveryRouter } = require('../src/routes/admin/interviewRecovery');

const ID = {
  candidate: '76000000-0000-4000-8000-000000000001',
  client: '76000000-0000-4000-8000-000000000002',
  otherClient: '76000000-0000-4000-8000-000000000003',
  role: '76000000-0000-4000-8000-000000000004',
  interview: '76000000-0000-4000-8000-000000000005',
  authorization: '76000000-0000-4000-8000-000000000006',
  actor: '76000000-0000-4000-8000-000000000007',
  report: '76000000-0000-4000-8000-000000000008',
};
const EXACT = `alphascreen-interview-${ID.interview}`;

function row(index, name = `other-${index}`) {
  return {
    conversation_id: `conversation-${index}`,
    conversation_name: name,
    conversation_url: `https://tavus.daily.co/conversation-${index}`,
  };
}

function providerWith(handler) {
  return createTavusReadOnlyProvider({
    apiKey: 'test-key',
    httpClient: { get: async (_url, options) => ({ data: await handler(options.params.page) }) },
  });
}

test('R2 pagination 1. missing total_count is incomplete', async () => {
  const result = await providerWith(async () => ({ data: [] })).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_missing_total');
});

test('R2 pagination 2. a list requiring another page fails closed before a changing total can matter', async () => {
  let calls = 0;
  const result = await providerWith(async (page) => {
    calls += 1;
    return {
      total_count: page === 1 ? 101 : 102,
      data: page === 1 ? Array.from({ length: 100 }, (_, index) => row(index)) : [row(100)],
    };
  }).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(calls, 1);
});

test('R2 pagination 3. repeated page content is never requested for automatic reconciliation', async () => {
  const repeated = Array.from({ length: 100 }, (_, index) => row(index));
  let calls = 0;
  const result = await providerWith(async () => {
    calls += 1;
    return { total_count: 200, data: repeated };
  }).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(calls, 1);
});

test('R2 pagination 4. a short page before validated total is incomplete', async () => {
  const result = await providerWith(async () => ({ total_count: 2, data: [row(0)] })).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_short_page');
});

test('R2 pagination 5. a large account never traverses to page-limit exhaustion', async () => {
  let calls = 0;
  const result = await providerWith(async (page) => {
    calls += 1;
    return {
      total_count: 2600,
      data: Array.from({ length: 100 }, (_, index) => row(((page - 1) * 100) + index)),
    };
  }).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(result.total_exact_match_count, null);
  assert.equal(calls, 1);
});

test('R2 pagination 6. a page-one exact match in a multi-page account remains unverified', async () => {
  let calls = 0;
  const result = await providerWith(async (page) => {
    calls += 1;
    return page === 1
      ? { total_count: 101, data: [row(0, EXACT), ...Array.from({ length: 99 }, (_, index) => row(index + 1))] }
      : { data: [row(100)] };
  }).findExactConversations(EXACT);
  assert.equal(result.complete, false);
  assert.equal(result.matches.length, 0);
  assert.equal(result.total_exact_match_count, null);
  assert.equal(result.scan_status, 'incomplete_multi_page_unsupported');
  assert.equal(calls, 1);
});

class RecoveryQuery {
  constructor(db) { this.db = db; this.filters = {}; }
  select() { return this; }
  eq(key, value) { this.filters[key] = value; return this; }
  maybeSingle() {
    const valid = this.filters.id === ID.interview
      && this.filters.candidate_id === ID.candidate
      && this.filters.client_id === ID.client
      && this.filters.role_id === ID.role
      && this.filters.replacement_authorization_id === ID.authorization;
    return Promise.resolve({ data: valid ? { id: ID.interview, vendor_start_state: this.db.vendorState } : null, error: null });
  }
}

function recoveryDb(vendorState = 'reconciliation_required', { serializeClaim = false } = {}) {
  return {
    vendorState,
    calls: [],
    reconciliationClaimed: false,
    from() { return new RecoveryQuery(this); },
    async rpc(name, args) {
      this.calls.push({ name, args });
      if (name === 'claim_interview_recovery_reconciliation_core') {
        if (serializeClaim && this.reconciliationClaimed) {
          return { data: [{ claimed: false, state: 'vendor_reconciliation_in_progress' }], error: null };
        }
        this.reconciliationClaimed = true;
        return { data: [{ claimed: true, claim_token: ID.actor, vendor_external_reference: EXACT }], error: null };
      }
      if (name === 'complete_interview_recovery_reconciliation_core') {
        return {
          data: args.p_outcome === 'resolved' ? 'started' : 'vendor_reconciliation_manual_review',
          error: null,
        };
      }
      if (name === 'recover_interview_vendor_binding_core') {
        return { data: [{ status: 'started', conversation_id: 'known-conversation' }], error: null };
      }
      return { data: null, error: { message: `unexpected:${name}` } };
    },
  };
}

async function withRecoveryServer({ db, isGlobalAdmin, provider, authenticated = true }, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) req.user = { id: ID.actor, email: 'platform@example.test' };
    req.isGlobalAdmin = isGlobalAdmin;
    next();
  });
  app.use('/admin/interview-recovery', createInterviewRecoveryRouter({
    db,
    featureEnabled: () => true,
    tavusReadOnlyProviderFactory: () => provider,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function reconciliationBody(overrides = {}) {
  return {
    client_id: ID.client,
    role_id: ID.role,
    interview_id: ID.interview,
    authorization_id: ID.authorization,
    ...overrides,
  };
}

test('R2 reconciliation authorization 7. ordinary client users cannot invoke the platform action', async () => {
  const db = recoveryDb();
  let lookups = 0;
  await withRecoveryServer({ db, isGlobalAdmin: false, provider: { findExactConversations: async () => { lookups += 1; } } }, async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    assert.equal(response.status, 403);
  });
  assert.equal(lookups, 0);
  assert.equal(db.calls.length, 0);
});

test('R2 reconciliation authorization 7a. unauthenticated requests fail before database or provider access', async () => {
  const db = recoveryDb();
  let lookups = 0;
  await withRecoveryServer({
    db,
    isGlobalAdmin: false,
    authenticated: false,
    provider: { findExactConversations: async () => { lookups += 1; } },
  }, async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    assert.equal(response.status, 401);
  });
  assert.equal(lookups, 0);
  assert.equal(db.calls.length, 0);
});

test('R2 reconciliation authorization 8. platform admin gets bounded manual review on zero match', async () => {
  const db = recoveryDb();
  const provider = { findExactConversations: async () => ({
    complete: true, scan_status: 'complete', matches: [], total_exact_match_count: 0,
    pages_requested: 1, pages_completed: 1, total_count_reported: 0,
  }) };
  await withRecoveryServer({ db, isGlobalAdmin: true, provider }, async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'vendor_reconciliation_manual_review');
    assert.equal(body.conversation_id, null);
    assert.equal(body.scan_status, 'complete');
  });
});

test('R2 reconciliation authorization 9. arrays and mismatched bindings fail before provider access', async () => {
  const db = recoveryDb();
  let lookups = 0;
  const provider = { findExactConversations: async () => { lookups += 1; return {}; } };
  await withRecoveryServer({ db, isGlobalAdmin: true, provider }, async (base) => {
    const malformed = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody({ interview_id: [ID.interview] })),
    });
    assert.equal(malformed.status, 400);
    const mismatch = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody({ client_id: ID.otherClient })),
    });
    assert.equal(mismatch.status, 404);
  });
  assert.equal(lookups, 0);
});

test('R2 reconciliation outcomes 9a. one complete exact match binds through the protected endpoint', async () => {
  const db = recoveryDb();
  const provider = { findExactConversations: async () => ({
    complete: true,
    scan_status: 'complete',
    matches: [row(1, EXACT)],
    total_exact_match_count: 1,
    pages_requested: 1,
    pages_completed: 1,
    total_count_reported: 1,
  }) };
  await withRecoveryServer({ db, isGlobalAdmin: true, provider }, async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'started');
    assert.equal(body.conversation_id, 'conversation-1');
    assert.equal(body.scan_status, 'complete');
  });
});

test('R2 reconciliation outcomes 9b. multiple, incomplete, and unavailable scans stay manual-review-only', async () => {
  const cases = [
    {
      provider: { findExactConversations: async () => ({
        complete: true, scan_status: 'complete', matches: [row(1, EXACT), row(2, EXACT)],
        total_exact_match_count: 2, pages_requested: 1, pages_completed: 1, total_count_reported: 2,
      }) },
      expectedStatus: 200,
      expectedScanStatus: 'complete',
      expectedMatchCount: 2,
    },
    {
      provider: { findExactConversations: async () => ({
        complete: false, scan_status: 'incomplete_missing_total', matches: [row(1, EXACT)],
        total_exact_match_count: null, pages_requested: 1, pages_completed: 0, total_count_reported: null,
      }) },
      expectedStatus: 200,
      expectedScanStatus: 'incomplete_missing_total',
      expectedMatchCount: null,
    },
    {
      provider: { findExactConversations: async () => { throw new Error('provider unavailable'); } },
      expectedStatus: 200,
      expectedScanStatus: 'unavailable',
      expectedMatchCount: null,
    },
  ];
  for (const fixture of cases) {
    const db = recoveryDb();
    await withRecoveryServer({ db, isGlobalAdmin: true, provider: fixture.provider }, async (base) => {
      const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
      });
      assert.equal(response.status, fixture.expectedStatus);
      const body = await response.json();
      assert.equal(body.status, 'vendor_reconciliation_manual_review');
      assert.equal(body.scan_status, fixture.expectedScanStatus);
      assert.equal(body.match_count, fixture.expectedMatchCount);
      assert.equal(body.conversation_id, null);
    });
    assert.equal(db.calls.some((call) => call.name.includes('create')), false);
  }
});

test('R2 reconciliation outcomes 9c. concurrent protected actions perform one provider lookup', async () => {
  const db = recoveryDb('reconciliation_required', { serializeClaim: true });
  let lookups = 0;
  const provider = { findExactConversations: async () => {
    lookups += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      complete: true, scan_status: 'complete', matches: [], total_exact_match_count: 0,
      pages_requested: 1, pages_completed: 1, total_count_reported: 0,
    };
  } };
  await withRecoveryServer({ db, isGlobalAdmin: true, provider }, async (base) => {
    const request = () => fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    const responses = await Promise.all([request(), request()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  });
  assert.equal(lookups, 1);
});

test('R2 binding recovery 10. known provider success invokes only database binding recovery', async () => {
  const db = recoveryDb('binding_recovery_required');
  let lookups = 0;
  await withRecoveryServer({ db, isGlobalAdmin: true, provider: { findExactConversations: async () => { lookups += 1; } } }, async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/reconcile-vendor-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reconciliationBody()),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.operation, 'database_binding_recovery');
    assert.equal(body.status, 'started');
  });
  assert.equal(lookups, 0);
  assert.equal(db.calls.filter((call) => call.name === 'recover_interview_vendor_binding_core').length, 1);
});

class ReportQuery {
  constructor(db, table) { this.db = db; this.table = table; this.filters = {}; }
  select() { return this; }
  eq(key, value) { this.filters[key] = value; return this; }
  maybeSingle() {
    this.db.order.push(`lookup:${this.table}`);
    const error = this.db.errors[this.table] || null;
    return Promise.resolve({ data: error ? null : (this.db.rows[this.table] || null), error });
  }
}

function reportDb(overrides = {}) {
  const db = {
    rows: {
      reports: {
        id: ID.report, storage_path: `${ID.client}/reports/${ID.report}.pdf`, path: null,
        file_path: null, report_url: null, candidate_id: ID.candidate, client_id: null,
        role_id: null, interview_id: null,
      },
      candidates: { id: ID.candidate, client_id: ID.client, role_id: ID.role },
      interviews: null,
    },
    errors: {},
    signed: 0,
    order: [],
    from(table) { return new ReportQuery(db, table); },
    storage: { from() { return { createSignedUrl: async (key) => {
      db.order.push(`sign:${key}`); db.signed += 1;
      return { data: { signedUrl: 'https://signed.example.test/report' }, error: null };
    } }; } },
  };
  Object.assign(db.rows, overrides.rows || {});
  Object.assign(db.errors, overrides.errors || {});
  return db;
}

async function withHistoricalReportRouter(db, clientIds, callback) {
  const supabasePath = require.resolve('../src/clients/supabase');
  const authPath = require.resolve('../src/middleware/auth');
  const routePath = require.resolve('../src/routes/client/reports');
  const priorSupabase = require.cache[supabasePath];
  const priorAuth = require.cache[authPath];
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { supabase: db } };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
    requireAuth: (req, _res, next) => { req.user = { id: ID.actor }; next(); },
    withClientScope: (req, _res, next) => { req.clientIds = clientIds; next(); },
  } };
  delete require.cache[routePath];
  const app = express();
  app.use('/reports', require('../src/routes/client/reports'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[routePath];
    if (priorSupabase) require.cache[supabasePath] = priorSupabase; else delete require.cache[supabasePath];
    if (priorAuth) require.cache[authPath] = priorAuth; else delete require.cache[authPath];
  }
}

test('R2 historical report 11. malformed IDs and database failures never sign storage', async () => {
  const db = reportDb({ errors: { reports: { code: 'db_down' } } });
  await withHistoricalReportRouter(db, [ID.client], async (base) => {
    assert.equal((await fetch(`${base}/reports/not-a-uuid/download`, { redirect: 'manual' })).status, 400);
    assert.equal((await fetch(`${base}/reports/${ID.report}/download`, { redirect: 'manual' })).status, 503);
  });
  assert.equal(db.signed, 0);
});

test('R2 historical report 12. insufficient ownership and wrong scope never sign storage', async () => {
  const missingOwner = reportDb({ rows: { candidates: null } });
  await withHistoricalReportRouter(missingOwner, [ID.client], async (base) => {
    assert.equal((await fetch(`${base}/reports/${ID.report}/download`, { redirect: 'manual' })).status, 403);
  });
  assert.equal(missingOwner.signed, 0);
  const wrongScope = reportDb();
  await withHistoricalReportRouter(wrongScope, [ID.otherClient], async (base) => {
    assert.equal((await fetch(`${base}/reports/${ID.report}/download`, { redirect: 'manual' })).status, 403);
  });
  assert.equal(wrongScope.signed, 0);
});

test('R2 historical report 13. authorized null-client legacy owner signs only after ownership lookup', async () => {
  const db = reportDb();
  await withHistoricalReportRouter(db, [ID.client], async (base) => {
    const response = await fetch(`${base}/reports/${ID.report}/download`, { redirect: 'manual' });
    assert.equal(response.status, 302);
  });
  assert.equal(db.signed, 1);
  assert.deepEqual(db.order, [
    'lookup:reports',
    'lookup:candidates',
    `sign:${ID.client}/reports/${ID.report}.pdf`,
  ]);
});

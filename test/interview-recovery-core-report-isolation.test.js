'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const express = require('express');

const ID = {
  client: '75000000-0000-4000-8000-000000000001',
  otherClient: '75000000-0000-4000-8000-000000000002',
  role: '75000000-0000-4000-8000-000000000003',
  otherRole: '75000000-0000-4000-8000-000000000004',
  candidate: '75000000-0000-4000-8000-000000000005',
  otherCandidate: '75000000-0000-4000-8000-000000000006',
  prior: '75000000-0000-4000-8000-000000000007',
  replacement: '75000000-0000-4000-8000-000000000008',
  legacy: '75000000-0000-4000-8000-000000000009',
  priorBound: '75000000-0000-4000-8000-000000000010',
  exact: '75000000-0000-4000-8000-000000000011',
  resume: '75000000-0000-4000-8000-000000000012',
  inserted: '75000000-0000-4000-8000-000000000013',
  resumeTiebreakWinner: '75000000-0000-4000-8000-000000000015',
};

function exactInterview() {
  return {
    id: ID.replacement,
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    attempt_number: 2,
    replacement_authorization_id: '75000000-0000-4000-8000-000000000014',
    analysis: { summary: 'ATTEMPT_TWO_INTERVIEW_SUMMARY' },
    interview_summary: 'ATTEMPT_TWO_INTERVIEW_SUMMARY',
  };
}

function report(overrides = {}) {
  return {
    id: ID.exact,
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    interview_id: ID.replacement,
    attempt_number: 2,
    report_kind: 'complete_interview',
    analysis: { interview: { summary: 'ATTEMPT_TWO_REPORT_SUMMARY' } },
    interview_breakdown: { summary: 'ATTEMPT_TWO_REPORT_SUMMARY' },
    resume_breakdown: { summary: 'SAFE_RESUME' },
    report_url: `${ID.candidate}/exact.pdf`,
    ...overrides,
  };
}

function project(row, columns) {
  if (!row || !columns) return row;
  const keys = columns.split(',').map((key) => key.trim());
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]));
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = new Map();
    this.columns = '';
    this.operation = 'select';
  }
  select(columns) { this.columns = columns; return this; }
  eq(key, value) { this.filters.set(key, value); return this; }
  is(key, value) { this.filters.set(key, value); return this; }
  order(key, options = {}) {
    if (!this.ordering) this.ordering = [];
    this.ordering.push({ key, ascending: options.ascending === true });
    return this;
  }
  limit() { this.limited = true; return this; }
  insert(value) { this.operation = 'insert'; this.value = value; this.db.inserts.push(value); return this; }
  update(value) { this.operation = 'update'; this.value = value; this.db.updates.push(value); return this; }
  maybeSingle() { return Promise.resolve(this.db.resolve(this, true)); }
  single() { return Promise.resolve(this.db.resolve(this, true)); }
  then(resolve, reject) { return Promise.resolve(this.db.resolve(this, false)).then(resolve, reject); }
}

function createDb({ interviews = [exactInterview()], reports = [], candidates = null, roles = null } = {}) {
  const db = {
    interviews,
    reports,
    inserts: [],
    updates: [],
    queries: [],
    signed: 0,
    uploaded: 0,
    from(table) { const query = new Query(db, table); db.queries.push(query); return query; },
    resolve(query, single) {
      if (query.operation === 'update') return { data: null, error: null };
      if (query.operation === 'insert') {
        return { data: project({ id: ID.inserted, created_at: '2026-07-21T00:00:00.000Z', ...query.value }, query.columns), error: null };
      }
      let rows;
      if (query.table === 'interviews') rows = db.interviews;
      else if (query.table === 'reports') rows = db.reports;
      else if (query.table === 'candidates') rows = candidates || [
        { id: ID.candidate, client_id: ID.client, role_id: ID.role, name: 'Synthetic Candidate', email: 'synthetic@example.test', analysis_summary: {} },
        { id: ID.otherCandidate, client_id: ID.otherClient, role_id: ID.otherRole, name: 'Other Candidate', email: 'other@example.test', analysis_summary: {} },
      ];
      else if (query.table === 'roles') rows = roles || [
        { id: ID.role, client_id: ID.client, title: 'Synthetic Role' },
        { id: ID.otherRole, client_id: ID.otherClient, title: 'Other Role' },
      ];
      else if (query.table === 'clients') rows = [{ id: ID.client, name: 'Synthetic Client' }, { id: ID.otherClient, name: 'Other Client' }];
      else rows = [];
      const filtered = rows.filter((row) => Array.from(query.filters.entries()).every(([key, value]) => {
        if (value === null) return row[key] == null;
        return String(row[key]) === String(value);
      }));
      if (query.ordering?.length) {
        filtered.sort((left, right) => {
          for (const { key, ascending } of query.ordering) {
            const comparison = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
            if (comparison) return ascending ? comparison : -comparison;
          }
          return 0;
        });
      }
      const projected = filtered.map((row) => project(row, query.columns));
      return { data: single ? (projected[0] || null) : projected.slice(0, query.limited ? 1 : undefined), error: null };
    },
    storage: {
      from() {
        return {
          upload: async () => { db.uploaded += 1; return { error: null }; },
          createSignedUrl: async () => { db.signed += 1; return { data: { signedUrl: 'https://example.test/signed' }, error: null }; },
        };
      },
    },
  };
  return db;
}

async function withRouter(db, callback) {
  const capture = { payloads: [] };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../src/clients/supabase' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) {
      return { supabaseAdmin: db, supabase: db };
    }
    if (request === '../src/render/pdfRenderer' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) return { htmlToPdf: async (html) => Buffer.from(html) };
    if (request === '../src/render/candidateReport' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) {
      return { buildCandidateReportHtml: (payload) => { capture.payloads.push(payload); return JSON.stringify(payload); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const path = require.resolve('../src/routes/client/reportsPdf');
  delete require.cache[path];
  try {
    const router = require('../src/routes/client/reportsPdf');
    await callback(router, capture);
  } finally {
    Module._load = originalLoad;
    delete require.cache[path];
  }
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function generate(router, body, clientIds = [ID.client]) {
  const res = response();
  await router._handleGenerate({ body, query: {}, clientIds }, res);
  return res;
}

async function withServer(router, clientIds, callback) {
  const app = express();
  app.use((req, _res, next) => { req.clientIds = clientIds; next(); });
  app.use('/reports', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Report isolation 1. unbound attempt-one report is rejected for attempt two and never rendered', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy, interview_id: null, attempt_number: null, report_kind: null, analysis: { interview: { summary: 'ATTEMPT_ONE_SENTINEL' } } })] });
  await withRouter(db, async (router, capture) => {
    const res = await generate(router, { candidate_id: ID.candidate, interview_id: ID.replacement, report_id: ID.legacy });
    assert.equal(res.statusCode, 409);
    assert.equal(capture.payloads.length, 0);
  });
});

test('Report isolation 2. report bound to attempt one is rejected for exact attempt two', async () => {
  const db = createDb({ reports: [report({ id: ID.priorBound, interview_id: ID.prior, attempt_number: 1 })] });
  await withRouter(db, async (router) => assert.equal((await generate(router, { interview_id: ID.replacement, report_id: ID.priorBound })).statusCode, 409));
});

test('Report isolation 3. cross-candidate unbound report is rejected', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy, candidate_id: ID.otherCandidate, interview_id: null, attempt_number: null, report_kind: null })] });
  await withRouter(db, async (router) => assert.equal((await generate(router, { candidate_id: ID.candidate, interview_id: ID.replacement, report_id: ID.legacy }, [ID.client, ID.otherClient])).statusCode, 409));
});

test('Report isolation 4. cross-client unbound report is rejected before rendering', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy, client_id: ID.otherClient, interview_id: null, attempt_number: null, report_kind: null })] });
  await withRouter(db, async (router) => assert.equal((await generate(router, { interview_id: ID.replacement, report_id: ID.legacy })).statusCode, 403));
});

test('Report isolation 5. cross-role report is rejected', async () => {
  const db = createDb({ reports: [report({ role_id: ID.otherRole })] });
  await withRouter(db, async (router) => assert.equal((await generate(router, { interview_id: ID.replacement, report_id: ID.exact })).statusCode, 409));
});

test('Report isolation 6. exact resume-only seed copies only allowlisted resume fields', async () => {
  const resume = report({
    id: ID.resume,
    interview_id: null,
    attempt_number: null,
    report_kind: 'resume_only',
    resume_score: 88,
    resume_breakdown: {
      summary: 'SAFE_RESUME',
      skills_match_percent: 91,
      interview_analysis: { summary: 'FORBIDDEN_NESTED_SENTINEL' },
      unknown_nested: { value: 'FORBIDDEN_UNKNOWN_SENTINEL' },
    },
    analysis: { interview: { summary: 'FORBIDDEN_SENTINEL' } },
  });
  const db = createDb({ reports: [resume] });
  await withRouter(db, async (router, capture) => {
    const res = await generate(router, { interview_id: ID.replacement });
    assert.equal(res.statusCode, 200);
    assert.equal(db.inserts.length, 1);
    assert.deepEqual(Object.keys(db.inserts[0]).sort(), ['attempt_number', 'candidate_id', 'client_id', 'interview_id', 'report_kind', 'resume_breakdown', 'resume_score', 'role_id'].sort());
    assert.deepEqual(db.inserts[0].resume_breakdown, { summary: 'SAFE_RESUME', skills_match_percent: 91 });
    assert.doesNotMatch(JSON.stringify(capture.payloads[0]), /FORBIDDEN_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(db.inserts[0]), /FORBIDDEN_NESTED_SENTINEL|FORBIDDEN_UNKNOWN_SENTINEL/);
  });
});

test('Report isolation 7. resume-only report from another candidate is rejected as supplied source', async () => {
  const db = createDb({ reports: [report({ id: ID.resume, candidate_id: ID.otherCandidate, interview_id: null, attempt_number: null, report_kind: 'resume_only' })] });
  await withRouter(db, async (router) => assert.equal((await generate(router, { candidate_id: ID.candidate, interview_id: ID.replacement, report_id: ID.resume }, [ID.client, ID.otherClient])).statusCode, 409));
});

test('Report isolation 7a. malformed resume breakdown fails safely without copying nested data', async () => {
  const db = createDb({ reports: [report({
    id: ID.resume,
    interview_id: null,
    attempt_number: null,
    report_kind: 'resume_only',
    resume_score: 88,
    resume_breakdown: ['MALFORMED_RESUME_SENTINEL'],
  })] });
  await withRouter(db, async (router) => {
    assert.equal((await generate(router, { interview_id: ID.replacement })).statusCode, 200);
    assert.equal(db.inserts[0].resume_breakdown, null);
    assert.doesNotMatch(JSON.stringify(db.inserts[0]), /MALFORMED_RESUME_SENTINEL/);
  });
});

test('Report isolation 7b. equal resume timestamps use descending stable report ID as tiebreaker', async () => {
  const createdAt = '2026-07-21T12:00:00.000Z';
  const db = createDb({ reports: [
    report({
      id: ID.resume,
      created_at: createdAt,
      interview_id: null,
      attempt_number: null,
      report_kind: 'resume_only',
      resume_score: 80,
      resume_breakdown: { summary: 'LOSING_RESUME_TIEBREAK' },
    }),
    report({
      id: ID.resumeTiebreakWinner,
      created_at: createdAt,
      interview_id: null,
      attempt_number: null,
      report_kind: 'resume_only',
      resume_score: 92,
      resume_breakdown: { summary: 'WINNING_RESUME_TIEBREAK' },
    }),
  ] });
  await withRouter(db, async (router) => {
    assert.equal((await generate(router, { interview_id: ID.replacement })).statusCode, 200);
    assert.equal(db.inserts[0].resume_score, 92);
    assert.deepEqual(db.inserts[0].resume_breakdown, { summary: 'WINNING_RESUME_TIEBREAK' });
  });
});

test('Report isolation 8. exact attempt-two complete report is accepted', async () => {
  const db = createDb({ reports: [report()] });
  await withRouter(db, async (router, capture) => {
    assert.equal((await generate(router, { interview_id: ID.replacement, report_id: ID.exact })).statusCode, 200);
    assert.equal(capture.payloads[0].interview_summary, 'ATTEMPT_TWO_INTERVIEW_SUMMARY');
  });
});

test('Report isolation 9. authorized historical legacy report remains downloadable', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy, client_id: null, role_id: null, interview_id: null, attempt_number: null, report_kind: null, report_url: 'legacy/report.pdf' })] });
  await withRouter(db, async (router) => withServer(router, [ID.client], async (base) => {
    const res = await fetch(`${base}/reports/${ID.legacy}/url`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).report_id, ID.legacy);
  }));
});

test('Report isolation 10. legacy report route rejects wrong-client scope', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy })] });
  await withRouter(db, async (router) => withServer(router, [ID.otherClient], async (base) => {
    assert.equal((await fetch(`${base}/reports/${ID.legacy}/url`)).status, 403);
    assert.equal(db.signed, 0);
  }));
});

test('Report isolation 11. exact interview URL never falls back to candidate-wide latest report', async () => {
  const db = createDb({ reports: [report({ id: ID.legacy, interview_id: null, attempt_number: null, report_kind: null })] });
  await withRouter(db, async (router) => withServer(router, [ID.client], async (base) => {
    assert.equal((await fetch(`${base}/reports/interviews/${ID.replacement}/url`)).status, 404);
    assert.equal(db.signed, 0);
  }));
});

test('Report isolation 11a. exact interview URL requires candidate, client, role, and attempt binding', async () => {
  const db = createDb({ reports: [report({ role_id: ID.otherRole, attempt_number: 1 })] });
  await withRouter(db, async (router) => withServer(router, [ID.client], async (base) => {
    assert.equal((await fetch(`${base}/reports/interviews/${ID.replacement}/url`)).status, 404);
    assert.equal(db.signed, 0);
  }));
});

test('Report isolation 12. generated replacement payload contains no attempt-one analysis sentinel', async () => {
  const db = createDb({
    interviews: [exactInterview(), { id: ID.prior, candidate_id: ID.candidate, client_id: ID.client, role_id: ID.role, attempt_number: 1, interview_summary: 'ATTEMPT_ONE_SENTINEL' }],
    reports: [report(), report({ id: ID.priorBound, interview_id: ID.prior, attempt_number: 1, analysis: { interview: { summary: 'ATTEMPT_ONE_SENTINEL' } } })],
  });
  await withRouter(db, async (router, capture) => {
    assert.equal((await generate(router, { interview_id: ID.replacement })).statusCode, 200);
    assert.doesNotMatch(JSON.stringify(capture.payloads[0]), /ATTEMPT_ONE_SENTINEL/);
  });
});

test('Finding #2 red: legacy generation rejects report-to-candidate client mismatch before render', async () => {
  const db = createDb({
    reports: [report({ interview_id: null, attempt_number: null, report_kind: null })],
    candidates: [{
      id: ID.candidate,
      client_id: ID.otherClient,
      role_id: ID.role,
      name: 'Foreign Candidate',
      email: 'foreign@example.test',
      analysis_summary: {},
    }],
  });
  await withRouter(db, async (router, capture) => {
    const res = await generate(router, { candidate_id: ID.candidate }, [ID.client]);
    assert.equal(res.statusCode, 409);
    assert.equal(capture.payloads.length, 0);
    assert.equal(db.uploaded, 0);
  });
});

test('Finding #2 red: legacy generation rejects latest-interview client mismatch before render', async () => {
  const db = createDb({
    reports: [report({ interview_id: null, attempt_number: null, report_kind: null })],
    interviews: [{
      ...exactInterview(),
      client_id: ID.otherClient,
      interview_summary: 'FOREIGN_INTERVIEW_SENTINEL',
      analysis: { summary: 'FOREIGN_INTERVIEW_SENTINEL' },
    }],
  });
  await withRouter(db, async (router, capture) => {
    const res = await generate(router, { candidate_id: ID.candidate }, [ID.client]);
    assert.equal(res.statusCode, 409);
    assert.equal(capture.payloads.length, 0);
    assert.equal(db.uploaded, 0);
  });
});

test('Report isolation validation. malformed report and interview UUIDs fail before database or storage access', async () => {
  const db = createDb({ reports: [report()] });
  await withRouter(db, async (router) => {
    assert.equal((await generate(router, { interview_id: 'not-a-uuid' })).statusCode, 400);
    await withServer(router, [ID.client], async (base) => {
      assert.equal((await fetch(`${base}/reports/not-a-uuid/url`)).status, 400);
      assert.equal((await fetch(`${base}/reports/interviews/not-a-uuid/url`)).status, 400);
    });
    assert.equal(db.signed, 0);
  });
});

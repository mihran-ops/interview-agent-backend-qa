'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

const ID = {
  client: '73000000-0000-4000-8000-000000000001',
  role: '73000000-0000-4000-8000-000000000002',
  candidate: '73000000-0000-4000-8000-000000000003',
  priorInterview: '73000000-0000-4000-8000-000000000004',
  replacementInterview: '73000000-0000-4000-8000-000000000005',
  legacyReport: '73000000-0000-4000-8000-000000000006',
};

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = new Map();
  }
  select() { return this; }
  eq(column, value) { this.filters.set(column, value); return this; }
  is(column, value) { this.filters.set(column, value); return this; }
  order() { return this; }
  limit() { return this; }
  update(value) { this.db.updates.push({ table: this.table, value }); return this; }
  insert(value) { this.db.inserts.push({ table: this.table, value }); return this; }
  maybeSingle() { return Promise.resolve(this.db.resolve(this.table, this.filters)); }
  single() { return Promise.resolve(this.db.resolve(this.table, this.filters)); }
  then(resolve, reject) { return Promise.resolve(this.db.resolve(this.table, this.filters)).then(resolve, reject); }
}

function createReportDb() {
  const db = {
    updates: [],
    inserts: [],
    from(table) { return new FakeQuery(db, table); },
    resolve(table, filters) {
      if (table === 'interviews' && filters.get('id') === ID.replacementInterview) {
        return { data: {
          id: ID.replacementInterview,
          candidate_id: ID.candidate,
          client_id: ID.client,
          role_id: ID.role,
          attempt_number: 2,
          replacement_authorization_id: '73000000-0000-4000-8000-000000000007',
          analysis: { summary: 'ATTEMPT_TWO_SUMMARY' },
        }, error: null };
      }
      if (table === 'reports' && filters.get('id') === ID.legacyReport) {
        return { data: {
          id: ID.legacyReport,
          candidate_id: ID.candidate,
          client_id: ID.client,
          role_id: ID.role,
          interview_id: null,
          attempt_number: null,
          report_kind: null,
          analysis: { interview: { summary: 'ATTEMPT_ONE_SENTINEL' } },
          interview_breakdown: { summary: 'ATTEMPT_ONE_SENTINEL' },
          resume_breakdown: {},
        }, error: null };
      }
      if (table === 'candidates') return { data: { id: ID.candidate, client_id: ID.client, role_id: ID.role, name: 'Synthetic', email: 'synthetic@example.test' }, error: null };
      if (table === 'roles') return { data: { id: ID.role, client_id: ID.client, title: 'Synthetic role' }, error: null };
      if (table === 'clients') return { data: { id: ID.client, name: 'Synthetic client' }, error: null };
      if (table === 'reports' && db.updates.length) return { data: null, error: null };
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          upload: async () => ({ error: null }),
          createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null }),
        };
      },
    },
  };
  return db;
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('R1 red report regression: an unbound attempt-one report is rejected for exact attempt two', async () => {
  const db = createReportDb();
  let renderedPayload = null;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../src/clients/supabase' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) {
      return { supabaseAdmin: db, supabase: db };
    }
    if (request === '../src/render/pdfRenderer' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) {
      return { htmlToPdf: async (html) => Buffer.from(html) };
    }
    if (request === '../src/render/candidateReport' && /routes\/reportsPdf\.js$/.test(parent?.filename || '')) {
      return { buildCandidateReportHtml: (payload) => { renderedPayload = payload; return JSON.stringify(payload); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  const routePath = require.resolve('../src/routes/client/reportsPdf');
  delete require.cache[routePath];
  try {
    const router = require('../src/routes/client/reportsPdf');
    const res = fakeResponse();
    await router._handleGenerate({
      body: { candidate_id: ID.candidate, interview_id: ID.replacementInterview, report_id: ID.legacyReport },
      query: {},
      clientIds: [ID.client],
    }, res);
    assert.equal(res.statusCode, 409, `current route rendered: ${JSON.stringify(renderedPayload)}`);
    assert.equal(renderedPayload, null);
  } finally {
    Module._load = originalLoad;
    delete require.cache[routePath];
  }
});

test('R1 red Tavus regression: transmitted timeout is classified ambiguous and uses exact interview identity', async () => {
  process.env.TAVUS_API_KEY = 'test-key';
  process.env.TAVUS_REPLICA_ID = 'test-replica';
  process.env.TAVUS_PERSONA_ID = 'test-persona';
  process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
  process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
  let sentPayload = null;
  const tavusHttpClient = {
    async createConversation(payload) {
      sentPayload = payload;
      const error = new Error('socket hang up after request transmission');
      error.code = 'ECONNRESET';
      error.category = 'network';
      error.attemptCount = 1;
      throw error;
    },
  };
  const { createTavusInterviewHandler } = require('../src/services/tavusInterview');
  const error = await createTavusInterviewHandler(
    { id: ID.candidate, name: 'Synthetic' },
    { id: ID.role, title: 'Synthetic role', tavus_document_id: 'document-test' },
    'https://example.test/webhook',
    { interviewId: ID.replacementInterview, maxInterviewMinutes: 10, tavusHttpClient },
  ).then(() => null, (caught) => caught);
  assert.equal(error?.failureCategory, 'ambiguous_acceptance');
  assert.equal(error?.retryable, false);
  assert.equal(sentPayload?.conversation_name, `alphascreen-interview-${ID.replacementInterview}`);
});

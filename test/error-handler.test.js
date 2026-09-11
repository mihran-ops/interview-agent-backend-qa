'use strict';

// The global error handler used to return err.message straight to the caller, which
// put database and vendor error text on the wire. These tests pin the replacement:
// a generic body for anything that is not client-attributable, and the original
// message only for 4xx errors a handler raised deliberately.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test, before, after } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const appPath = path.join(ROOT, 'app.js');
const supabaseClientPath = path.join(ROOT, 'src', 'lib', 'supabaseClient.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const generateRubricPath = path.join(ROOT, 'generateRubric.js');
const kbPath = path.join(ROOT, 'routes', 'kb.js');
const dotenvPath = require.resolve('dotenv');

// Every router except routes/kb.js, which is replaced by one that throws on demand.
const ROUTE_STUBS = [
  'routes/dashboard.js', 'routes/roles.js', 'routes/automation.js', 'routes/webhookStripe.js',
  'routes/webhookSendgrid.js', 'routes/webhookTelnyxSms.js', 'routes/webhook.js',
  'routes/candidateSubmit.js', 'routes/verifyOtp.js', 'routes/createTavusInterview.js',
  'routes/accommodationRequests.js', 'routes/textInterview.js', 'routes/clientMembersScoped.js',
  'routes/feedback.js', 'routes/alphaScreenPackages.js', 'routes/publicAnalytics.js',
  'routes/publicLeads.js', 'routes/adminBilling.js', 'routes/tavus.js',
  'routes/publicInterviewStatus.js', 'routes/membershipAgreementsPublic.js', 'routes/rolesUpload.js',
  'routes/files.js', 'routes/reports.js', 'routes/reportsPdf.js',
];

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function makeSupabaseStub() {
  const builder = {};
  for (const method of ['from', 'select', 'eq', 'in', 'order', 'limit', 'is', 'neq', 'not', 'or']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.single = async () => ({ data: null, error: null });
  builder.then = (resolve) => resolve({ data: [], error: null });
  return { from: () => builder, rpc: async () => ({ data: null, error: null }), auth: { admin: {} } };
}

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ERROR = console.error;
let app;

before(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://stub.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'stub-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.OPENAI_API_KEY = 'stub-openai-key';
  process.env.TAVUS_API_KEY = 'stub-tavus-key';

  globalThis.fetch = async () => { throw new Error('network disabled in tests'); };

  for (const filename of [appPath, supabaseClientPath, authPath, generateRubricPath, kbPath, dotenvPath,
    ...ROUTE_STUBS.map((relative) => path.join(ROOT, relative))]) {
    delete require.cache[filename];
  }
  for (const relative of ROUTE_STUBS) injectModule(path.join(ROOT, relative), express.Router());

  injectModule(dotenvPath, { config: () => ({ parsed: {} }) });
  const db = makeSupabaseStub();
  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db, supabaseAnon: db });
  injectModule(authPath, {
    requireAuth: (_req, _res, next) => next(),
    withClientScope: (_req, _res, next) => next(),
  });
  injectModule(generateRubricPath, {
    generateRubricAndKBForRole: async () => {},
    makeKBFromRubric: async () => ({}),
    generateJdDerivedArtifactsForRole: async () => ({}),
  });

  // Stands in for routes/kb.js so a real request reaches the global error handler.
  const throwing = express.Router();
  throwing.get('/boom', () => {
    throw new Error('connection to db-prod-7 refused: password authentication failed');
  });
  throwing.get('/async-boom', async () => {
    throw new Error('stripe secret sk_live_leaked is invalid');
  });
  throwing.get('/client-boom', () => {
    const error = new Error('missing_role_id');
    error.status = 400;
    throw error;
  });
  injectModule(kbPath, throwing);

  console.error = () => {};
  app = require(appPath);
});

after(() => {
  console.error = ORIGINAL_ERROR;
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

test('a thrown error answers 500 with a generic body and leaks no detail', async () => {
  const response = await request(app).get('/kb/boom');

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Server error' });
  assert.ok(!JSON.stringify(response.body).includes('db-prod-7'));
});

test('a rejected async handler answers 500 with a generic body', async () => {
  const response = await request(app).get('/kb/async-boom');

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Server error' });
  assert.ok(!JSON.stringify(response.body).includes('sk_live_leaked'));
});

test('a deliberate 4xx keeps its message', async () => {
  const response = await request(app).get('/kb/client-boom');

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: 'missing_role_id' });
});

test('the app exposes a shutdown entry point', () => {
  assert.equal(typeof app.shutdown, 'function');
});

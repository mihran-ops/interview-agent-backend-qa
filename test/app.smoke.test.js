'use strict';

// Smoke tests for the assembled application. These load app.js itself rather than
// mounting individual routers, so they cover middleware order, mount order and the
// auth guards as they are actually wired together.
//
// Only the modules that would reach the network are stubbed: the Supabase client,
// the auth middleware, the rubric generator, and the route modules that are not
// under test. The Stripe webhook router is deliberately left real so its signature
// verification runs for real. No database is involved.

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
const dotenvPath = require.resolve('dotenv');

// Every router except routes/webhookStripe.js, which must stay real.
const ROUTE_STUBS = [
  'routes/dashboard.js',
  'routes/roles.js',
  'routes/automation.js',
  'routes/webhookSendgrid.js',
  'routes/webhookTelnyxSms.js',
  'routes/webhook.js',
  'routes/candidateSubmit.js',
  'routes/verifyOtp.js',
  'routes/createTavusInterview.js',
  'routes/accommodationRequests.js',
  'routes/textInterview.js',
  'routes/clientMembersScoped.js',
  'routes/feedback.js',
  'routes/alphaScreenPackages.js',
  'routes/publicAnalytics.js',
  'routes/publicLeads.js',
  'routes/adminBilling.js',
  'routes/kb.js',
  'routes/tavus.js',
  'routes/publicInterviewStatus.js',
  'routes/membershipAgreementsPublic.js',
  'routes/rolesUpload.js',
  'routes/files.js',
  'routes/reports.js',
  'routes/reportsPdf.js',
];

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Minimal chainable stand-in for the Supabase query builder. Every terminal method
// resolves to an empty result, which is what the admin guard sees for a user that
// is not in the admins table.
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

// Swapped per test to control what requireAuth puts on the request.
let currentUser = null;

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
let app;

before(() => {
  // NODE_ENV=test makes the support-voice gateway use its no-op provider canary
  // instead of starting background probes.
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://stub.supabase.test';
  process.env.SUPABASE_ANON_KEY = 'stub-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
  process.env.CONTRACTS_CRON_SECRET = 'cron-secret-for-tests';
  process.env.OPENAI_API_KEY = 'stub-openai-key';
  process.env.TAVUS_API_KEY = 'stub-tavus-key';

  // The /healthz handler probes Supabase auth over the network with a 5s abort
  // timeout. Rejecting here keeps the suite offline and fast; the handler catches
  // the failure and still answers, which is what the health test asserts on.
  globalThis.fetch = async () => {
    throw new Error('network disabled in tests');
  };

  for (const filename of [appPath, supabaseClientPath, authPath, generateRubricPath, dotenvPath,
    ...ROUTE_STUBS.map((relative) => path.join(ROOT, relative))]) {
    delete require.cache[filename];
  }

  for (const relative of ROUTE_STUBS) {
    injectModule(path.join(ROOT, relative), express.Router());
  }

  injectModule(dotenvPath, { config: () => ({ parsed: {} }) });

  const db = makeSupabaseStub();
  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db, supabaseAnon: db });

  injectModule(authPath, {
    requireAuth: (req, res, next) => {
      if (!currentUser) return res.status(401).json({ error: 'Missing bearer token' });
      req.user = currentUser;
      return next();
    },
    withClientScope: (req, _res, next) => {
      req.client_memberships = [];
      req.clientIds = [];
      req.memberships = [];
      return next();
    },
  });

  injectModule(generateRubricPath, {
    generateRubricAndKBForRole: async () => {},
    makeKBFromRubric: async () => ({}),
    generateJdDerivedArtifactsForRole: async () => ({}),
  });

  app = require(appPath);
});

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

// The app must be importable at all: with the listen guard in place, requiring app.js
// binds no port and this suite can run alongside the rest of the test suite.
test('app.js can be required without binding a port', () => {
  assert.equal(typeof app, 'function', 'app.js should export the Express app');
  assert.equal(app.supportVoiceServer, undefined, 'no server should exist on a plain import');
});

// This is the test that would catch the /:token catch-all swallowing the health
// endpoints. GET /:token is registered at app.js:6716, before both health routes,
// and Express matches in registration order, so if that handler ever responds
// instead of deferring, /healthz stops returning its own payload and this fails.
test('GET /healthz returns 200 with the documented shape', async () => {
  currentUser = null;
  const response = await request(app).get('/healthz');

  assert.equal(response.status, 200);
  assert.equal(typeof response.body, 'object');
  for (const key of ['ok', 'degraded', 'request_id', 'now', 'supabase_auth',
    'tavus_webhook_auth', 'support_voice', 'interview_recovery_core']) {
    assert.ok(key in response.body, `expected /healthz payload to contain ${key}`);
  }
  assert.equal(typeof response.body.ok, 'boolean');
  assert.equal(typeof response.body.degraded, 'boolean');
  assert.equal(typeof response.body.supabase_auth, 'object');
});

test('GET /health returns 200 and the shallow payload', async () => {
  currentUser = null;
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
});

test('GET /admin/clients without auth is rejected with 401', async () => {
  currentUser = null;
  const response = await request(app).get('/admin/clients');

  // requireAuth rejects before requireAdmin is reached, so this is 401, not 403.
  assert.equal(response.status, 401);
});

test('GET /admin/clients as an authenticated non-admin is rejected with 403', async () => {
  currentUser = { id: 'user-1', email: 'not-an-admin@example.test' };
  const response = await request(app).get('/admin/clients');

  // The admins lookup returns no row, so the admin guard denies the request.
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'not_admin');
});

test('POST /webhook/stripe with no signature header returns 400', async () => {
  currentUser = null;
  const response = await request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .send(Buffer.from(JSON.stringify({ id: 'evt_test', type: 'ping' })));

  // Signature verification runs for real; a missing header cannot be verified.
  assert.equal(response.status, 400);
});

test('POST /webhook/stripe with a bad signature returns 400', async () => {
  currentUser = null;
  const response = await request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=notavalidsignature')
    .send(Buffer.from(JSON.stringify({ id: 'evt_test', type: 'ping' })));

  assert.equal(response.status, 400);
});

test('POST /internal/otp/cleanup without the cron header returns 403', async () => {
  currentUser = null;
  const response = await request(app).post('/internal/otp/cleanup');

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'forbidden');
});

test('POST /internal/otp/cleanup with a wrong cron secret returns 403', async () => {
  currentUser = null;
  const response = await request(app)
    .post('/internal/otp/cleanup')
    .set('x-cron-secret', 'not-the-configured-secret');

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'forbidden');
});

test('POST /internal/otp/cleanup returns 403 when the cron secret is unset', async () => {
  currentUser = null;
  const savedContracts = process.env.CONTRACTS_CRON_SECRET;
  const savedOtp = process.env.OTP_CLEANUP_CRON_SECRET;
  delete process.env.CONTRACTS_CRON_SECRET;
  delete process.env.OTP_CLEANUP_CRON_SECRET;

  try {
    // Fails closed: with no expected secret configured, any presented value is refused
    // rather than treated as a match against an empty string.
    const response = await request(app)
      .post('/internal/otp/cleanup')
      .set('x-cron-secret', '');

    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'forbidden');
  } finally {
    if (savedContracts === undefined) delete process.env.CONTRACTS_CRON_SECRET;
    else process.env.CONTRACTS_CRON_SECRET = savedContracts;
    if (savedOtp === undefined) delete process.env.OTP_CLEANUP_CRON_SECRET;
    else process.env.OTP_CLEANUP_CRON_SECRET = savedOtp;
  }
});

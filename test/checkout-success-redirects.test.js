'use strict';

// Redirect branches of GET /checkout/subscription-success. The handler decides where
// a buyer lands after Stripe returns, and every branch was previously untested.
//
// The router is exercised directly rather than through app.js: its four dependencies
// are stubbed by require.cache injection, and the real src/config/urlConfig builds the
// URLs so the assertions pin the actual redirect targets.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test, before, after } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const FRONTEND = 'https://frontend.test';

const routerPath = path.join(ROOT, 'src', 'routes', 'public', 'checkoutSuccess.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabaseClientPath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');
const provisioningPath = path.join(ROOT, 'src', 'services', 'users', 'userProvisioning.js');
const urlConfigPath = path.join(ROOT, 'src', 'config', 'urlConfig.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Swapped per test.
let session = null;
let sessionError = null;
let clientRow = null;
let returnState = null;

function makeSupabaseStub() {
  const builder = {
    select: () => builder,
    update: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: clientRow, error: null }),
    then: (resolve) => resolve({ data: null, error: null }),
  };
  return { from: () => builder };
}

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_LOG = console.log;
let app;

before(() => {
  // urlConfig resolves its bases at require time, so the env must be set first.
  process.env.FRONTEND_URL = FRONTEND;
  for (const key of ['PUBLIC_SITE_BASE', 'ACCOUNT_REDIRECT_BASE', 'PUBLIC_SITE_BASE_FALLBACK',
    'CLIENT_APP_BASE', 'CLIENT_AUTH_FRONTEND_BASE', 'CLIENT_APP_BASE_FALLBACK', 'FRONTEND_BASE']) {
    delete process.env[key];
  }

  for (const filename of [routerPath, urlConfigPath]) delete require.cache[filename];

  injectModule(stripeClientPath, {
    checkout: {
      sessions: {
        retrieve: async () => {
          if (sessionError) throw sessionError;
          return session;
        },
      },
    },
  });
  const db = makeSupabaseStub();
  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db, supabaseAnon: db });
  injectModule(activationPath, { resolvePublicCheckoutReturnState: async () => returnState });
  injectModule(provisioningPath, {
    ensureUserIdAndRecoveryLink: async () => ({ userId: null, actionLink: null, method: null }),
  });

  console.log = () => {};
  app = express();
  app.use('/checkout', require(routerPath));
});

after(() => {
  console.log = ORIGINAL_LOG;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

function reset() {
  session = null;
  sessionError = null;
  clientRow = null;
  returnState = null;
}

async function get(query) {
  return request(app).get('/checkout/subscription-success').query(query);
}

test('no session_id falls back to the client dashboard, preserving client_id and tab', async () => {
  reset();
  const response = await get({ client_id: 'client-1', tab: 'billing' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location,
    `${FRONTEND}/dashboard?checkout=success&client_id=client-1&tab=billing`);
});

test('a session from an unrecognised source goes to the dashboard, not the public page', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'paid',
    metadata: { source: 'something_else', client_id: 'client-2' },
  };
  const response = await get({ session_id: 'cs_1' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${FRONTEND}/dashboard?checkout=success&client_id=client-2`);
});

test('an incomplete admin session goes to the dashboard', async () => {
  reset();
  session = {
    status: 'open',
    payment_status: 'unpaid',
    metadata: { source: 'admin_subscription_checkout', client_id: 'client-3' },
  };
  const response = await get({ session_id: 'cs_2' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${FRONTEND}/dashboard?checkout=success&client_id=client-3`);
});

test('an incomplete agreement session goes to the public page as payment_pending', async () => {
  reset();
  session = {
    status: 'open',
    payment_status: 'unpaid',
    metadata: { source: 'agreement_checkout', client_id: 'client-4', agreement_id: 'agr-4' },
  };
  const response = await get({ session_id: 'cs_3' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location,
    `${FRONTEND}/checkout/subscription-success?checkout=success&status=payment_pending`
    + '&client_id=client-4&session_id=cs_3&agreement_id=agr-4');
});

test('a complete agreement session whose payment did not clear is payment_pending', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'unpaid',
    metadata: { source: 'agreement_checkout', client_id: 'client-5', agreement_id: 'agr-5' },
  };
  const response = await get({ session_id: 'cs_4' });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /status=payment_pending/);
});

test('a paid agreement session with an inactive subscription is activation_pending', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'paid',
    subscription: { status: 'incomplete', metadata: {} },
    metadata: { source: 'agreement_checkout', client_id: 'client-6', agreement_id: 'agr-6' },
  };
  const response = await get({ session_id: 'cs_5' });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /status=activation_pending/);
});

test('a settled agreement session reports the status the activation lookup returns', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'paid',
    subscription: { status: 'active', metadata: {} },
    metadata: { source: 'agreement_checkout', client_id: 'client-7', agreement_id: 'agr-7' },
  };
  returnState = { status: 'ready' };
  const response = await get({ session_id: 'cs_6' });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /status=ready/);
  assert.match(response.headers.location, /agreement_id=agr-7/);
});

test('a settled agreement session with no activation state defaults to setup_pending', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'paid',
    subscription: { status: 'active', metadata: {} },
    metadata: { source: 'agreement_checkout', client_id: 'client-8', agreement_id: 'agr-8' },
  };
  returnState = null;
  const response = await get({ session_id: 'cs_7' });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /status=setup_pending/);
});

test('an admin session whose client cannot be found still lands on the dashboard', async () => {
  reset();
  session = {
    status: 'complete',
    payment_status: 'paid',
    subscription: { status: 'active', metadata: {} },
    metadata: { source: 'admin_subscription_checkout', client_id: 'client-9' },
  };
  clientRow = null;
  const response = await get({ session_id: 'cs_8' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${FRONTEND}/dashboard?checkout=success&client_id=client-9`);
});

test('a Stripe failure falls back to the dashboard rather than surfacing the error', async () => {
  reset();
  sessionError = new Error('stripe is unreachable');
  const response = await get({ session_id: 'cs_9', client_id: 'client-10' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${FRONTEND}/dashboard?checkout=success&client_id=client-10`);
});

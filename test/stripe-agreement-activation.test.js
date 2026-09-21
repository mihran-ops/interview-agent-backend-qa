'use strict';

// Agreement-checkout activation across the settlement lifecycle.
//
// checkout.session.completed can arrive before the money settles for
// delayed-notification payment methods. The session branch therefore has to admit
// checkout.session.async_payment_succeeded as well, or an agreement paid that way never
// activates — while still refusing to grant anything on an unsettled event.
//
// The Stripe SDK, Supabase and the activation service are stubbed; no database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Records every write so the test can assert on side effects.
function makeDb(rows) {
  const db = {
    writes: [],
    from(table) {
      const q = {
        _t: table,
        select() { return q; },
        eq() { return q; },
        neq() { return q; },
        is() { return q; },
        in() { return q; },
        not() { return q; },
        order() { return q; },
        limit() { return q; },
        insert(r) { db.writes.push({ op: 'insert', table, row: r }); return Promise.resolve({ error: null }); },
        update(r) { db.writes.push({ op: 'update', table, row: r }); return q; },
        delete() { db.writes.push({ op: 'delete', table }); return q; },
        upsert(r) { db.writes.push({ op: 'upsert', table, row: r }); return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: rows[q._t] ?? null, error: null }); },
        then(resolve) { return resolve({ data: null, error: null }); },
      };
      return q;
    },
  };
  return db;
}

function loadApp(event, { intent } = {}) {
  for (const p of [routerPath, stripeClientPath, supabasePath, activationPath]) delete require.cache[p];

  const activationCalls = [];
  injectModule(activationPath, {
    activatePublicPurchaseAgreementCheckout: async (args) => {
      activationCalls.push(args);
      return { ok: true, status: 'activated' };
    },
  });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: {
      retrieve: async () => ({ id: 'sub_1', status: 'active', items: { data: [] }, metadata: {} }),
    },
  });
  const db = makeDb({
    clients: { id: 'client_1', stripe_subscription_id: null },
    public_purchase_intents: intent === null ? null : {
      id: 'ppi_1', agreement_id: 'agr_1', status: 'pending', activated_at: null,
      canceled_at: null, activation_claimed_at: null, activation_claim_key: null,
      ...(intent || {}),
    },
  });
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, db, activationCalls };
}

function session({ type = 'checkout.session.completed', payment_status, agreement = true }) {
  const metadata = agreement
    ? { source: 'agreement_checkout', agreement_id: 'agr_1', client_id: 'client_1', plan_tier: 'pro', billing_interval: 'monthly' }
    : { source: 'admin_subscription_checkout', client_id: 'client_1', plan_tier: 'pro', billing_interval: 'monthly' };
  return {
    id: `evt_${type}_${payment_status}`,
    type,
    created: 1789000000,
    data: {
      object: {
        id: 'cs_1', mode: 'subscription', status: 'complete', payment_status,
        customer: 'cus_1', subscription: 'sub_1', metadata,
      },
    },
  };
}

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

const clientUpdates = (db) => db.writes.filter((w) => w.op === 'update' && w.table === 'clients');

test('card path: a paid completed session activates the agreement', async () => {
  const { app, activationCalls } = loadApp(session({ payment_status: 'paid' }));

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1);
  assert.equal(activationCalls[0].agreementId, 'agr_1');
});

test('an unpaid completed session does not activate', async () => {
  const { app, activationCalls } = loadApp(session({ payment_status: 'unpaid' }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, [], 'money has not settled, so nothing may be granted');
});

test('async_payment_succeeded activates the agreement exactly once', async () => {
  const { app, activationCalls } = loadApp(
    session({ type: 'checkout.session.async_payment_succeeded', payment_status: 'paid' }));

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1, 'a delayed payment that settles must still activate');
});

test('async_payment_failed never activates and never runs the generic client update', async () => {
  const { app, db, activationCalls } = loadApp(
    session({ type: 'checkout.session.async_payment_failed', payment_status: 'unpaid' }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, []);
  assert.deepEqual(clientUpdates(db), [], 'a failed payment must not touch the client record');
});

test('a non-agreement subscription checkout with unpaid status does not update the client', async () => {
  const { app, db, activationCalls } = loadApp(
    session({ payment_status: 'unpaid', agreement: false }), { intent: null });

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, []);
  assert.deepEqual(clientUpdates(db), [],
    'the generic subscription path must require settlement too, like additional interviews');
});

test('a non-agreement subscription checkout that is paid still updates the client', async () => {
  const { app, db } = loadApp(
    session({ payment_status: 'paid', agreement: false }), { intent: null });

  assert.equal((await post(app)).status, 200);
  assert.ok(clientUpdates(db).length >= 1, 'a settled non-agreement checkout must still apply');
});

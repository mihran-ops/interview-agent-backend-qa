'use strict';

// Buying additional interviews, and the cases the route has to refuse.
//
// A top-up is a one-off Stripe payment for a quantity the buyer picks, priced
// from the client's own stored fee and locked to a single role. A client on the
// usage model must not be able to buy them at all: their overage is invoiced
// after the fact, so a prepaid top-up would charge for the same interviews
// twice.
//
// Stripe, Supabase and auth are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'client', 'billing.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const clientScopePath = path.join(ROOT, 'src', 'services', 'clientScope.js');
const clientBillingScopePath = path.join(ROOT, 'src', 'services', 'clientScope', 'clientBilling.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = 'client_1';
const ROLE = 'role_1';

function makeDb({ planTier = 'pro', billingModel = 'rollover', additionalInterviewFee = 35 } = {}) {
  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null, name: 'Acme Dental Group', email: 'owner@acme.example', stripe_customer_id: 'cus_1' }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      additional_interview_fee: additionalInterviewFee,
      included_interviews_per_role: 30,
      per_role_fee: 699,
      usage_interview_fee_cents: 2500,
      rollover_days: 90
    }],
    roles: [{ id: ROLE, client_id: CLIENT, title: 'Hygienist' }],
    role_interview_purchases: []
  });
}

function loadApp(db) {
  for (const p of [routerPath, supabasePath, stripeClientPath, authPath, clientScopePath, clientBillingScopePath]) {
    delete require.cache[p];
  }

  const sessions = [];
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, {
    customers: { retrieve: async (id) => ({ id }) },
    checkout: {
      sessions: {
        create: async (payload) => {
          sessions.push(payload);
          return { id: `cs_${sessions.length}`, url: 'https://checkout.stripe.test/cs_1' };
        }
      }
    }
  });
  injectModule(authPath, {
    requireAuth: (req, _res, next) => { req.user = { id: 'user_1' }; next(); },
    withClientScope: (req, _res, next) => {
      req.client_memberships = [CLIENT];
      req.clientScope = { memberships: [CLIENT] };
      next();
    }
  });
  injectModule(clientScopePath, { canViewLegalBillingForClient: () => true });
  injectModule(clientBillingScopePath, {
    hasClientWriteAccess: () => true,
    respondWithBillingScopeError: (res, scope, code) => res.status(500).json({ error: code }),
    sanitizeClientDashboardTab: (value, fallback) => String(value || fallback),
    wantsEmbeddedCheckout: () => false
  });

  const app = express();
  app.use(express.json());
  app.use('/', require(routerPath));
  return { app, sessions };
}

const buy = (app, body) =>
  request(app).post('/clients/billing/additional-interviews/checkout-session')
    .send({ client_id: CLIENT, role_id: ROLE, quantity: 5, ...body });

test('a Pro client buys the quantity it asked for at its own stored price', async () => {
  const db = makeDb({ additionalInterviewFee: 35 });
  const { app, sessions } = loadApp(db);

  const res = await buy(app, { quantity: 4 });

  assert.equal(res.status, 200);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].mode, 'payment', 'a top-up is a one-off, not a subscription');
  assert.equal(sessions[0].line_items[0].quantity, 4);
  assert.equal(sessions[0].line_items[0].price_data.unit_amount, 3500, 'dollars on the row, cents to Stripe');
  assert.equal(sessions[0].metadata.purchase_type, 'additional_interviews');
  assert.equal(sessions[0].metadata.role_id, ROLE);

  const purchases = db.tables.role_interview_purchases;
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].status, 'pending');
  assert.equal(purchases[0].quantity, 4);
  assert.equal(purchases[0].role_id, ROLE, 'a top-up is locked to one role');
});

test('an Essentials client buys at its own lower price', async () => {
  const { app, sessions } = loadApp(makeDb({ planTier: 'basic', billingModel: 'fixed', additionalInterviewFee: 30 }));

  assert.equal((await buy(app, { quantity: 2 })).status, 200);
  assert.equal(sessions[0].line_items[0].price_data.unit_amount, 3000);
});

test('a usage client is refused with its own code, not a price error', async () => {
  const db = makeDb({ planTier: 'enterprise', billingModel: 'usage', additionalInterviewFee: 0 });
  const { app, sessions } = loadApp(db);

  const res = await buy(app, { quantity: 3 });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'usage_billing_no_top_ups');
  assert.equal(res.body.code, 'USAGE_BILLING_NO_TOP_UPS');
  assert.match(res.body.detail, /invoice/i, 'the message must explain how they are billed instead');
  assert.deepEqual(sessions, [], 'no Stripe session may be opened');
  assert.deepEqual(db.tables.role_interview_purchases, [], 'and no pending purchase row left behind');
});

test('a usage client with a top-up price set is still refused', async () => {
  // The model decides, not whether someone happened to leave a fee on the row.
  const db = makeDb({ planTier: 'enterprise', billingModel: 'usage', additionalInterviewFee: 40 });
  const { app, sessions } = loadApp(db);

  const res = await buy(app, { quantity: 3 });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'USAGE_BILLING_NO_TOP_UPS');
  assert.deepEqual(sessions, []);
});

test('a legacy Enterprise row with no billing model is refused on the tier default', async () => {
  const db = makeDb({ planTier: 'enterprise', billingModel: null, additionalInterviewFee: 40 });
  const { app } = loadApp(db);

  assert.equal((await buy(app, { quantity: 1 })).body.code, 'USAGE_BILLING_NO_TOP_UPS');
});

test('a non-usage client with no usable price still gets the price error', async () => {
  const db = makeDb({ planTier: 'pro', billingModel: 'rollover', additionalInterviewFee: 0 });
  const { app, sessions } = loadApp(db);

  const res = await buy(app, { quantity: 1 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_additional_interview_fee');
  assert.deepEqual(sessions, []);
});

test('the quantity must be a positive whole number', async () => {
  const db = makeDb();
  const { app, sessions } = loadApp(db);

  for (const quantity of [0, -3, 2.5, 'ten', null]) {
    const res = await buy(app, { quantity });
    assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be refused`);
    assert.equal(res.body.error, 'invalid_quantity');
  }
  assert.deepEqual(sessions, []);
  assert.deepEqual(db.tables.role_interview_purchases, []);
});

test('a role belonging to someone else cannot be topped up', async () => {
  const db = makeDb();
  db.tables.roles.push({ id: 'role_theirs', client_id: 'client_2', title: 'Theirs' });
  const { app, sessions } = loadApp(db);

  const res = await buy(app, { role_id: 'role_theirs' });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'role_not_found');
  assert.deepEqual(sessions, []);
});

test('the refusal happens before any purchase row is written', () => {
  const source = fs.readFileSync(routerPath, 'utf8');
  const route = source.slice(source.indexOf("router.post('/clients/billing/additional-interviews/checkout-session'"));
  const refusalAt = route.indexOf('USAGE_BILLING_NO_TOP_UPS');
  const insertAt = route.indexOf("from('role_interview_purchases')");

  assert.ok(refusalAt > -1 && insertAt > -1);
  assert.ok(refusalAt < insertAt, 'a refused purchase must not leave a pending row behind');
});

test('the failed status the webhook writes is permitted by the constraint', () => {
  const webhook = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8');
  assert.match(webhook, /\.update\(\{ status: 'failed' \}\)/,
    'the webhook marks a permanently failed payment this way');

  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260924120000_role_interview_purchase_failed_status.sql'),
    'utf8'
  );
  assert.match(migration, /check \(status in \('pending', 'paid', 'failed', 'voided', 'refunded'\)\)/i,
    'without failed in the constraint the update is rejected and Stripe retries forever');
  assert.match(migration, /drop constraint role_interview_purchases_status_check/i,
    'the old constraint has to go before the wider one can be added');
});

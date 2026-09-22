'use strict';

// invoice.created adds a usage client's overage to its platform-fee invoice.
//
// The failure that matters most here is a partial one: Stripe accepting some
// items and then erroring. The ledger rows are reserved before any item is
// created and stamped after, so a retry re-attaches the rows it already reserved
// instead of billing the same interviews again.
//
// The Stripe SDK and Supabase are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = 'client_1';
const CUSTOMER = 'cus_1';
const SUBSCRIPTION = 'sub_1';
const INVOICE = 'in_1';
const PERIOD_END_UNIX = 1788220800; // 2026-09-01T00:00:00Z

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`
};

function usedInterviews(count, { roleId = 'role_1', prefix = 'iv' } = {}) {
  const start = new Date('2026-08-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: CLIENT,
    role_id: roleId,
    status: 'completed',
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

function makeDb({
  billingModel = 'usage',
  planTier = 'enterprise',
  included = 0,
  unitPriceCents = 2500,
  roles = [{ id: 'role_1', client_id: CLIENT, title: 'Hygienist' }],
  interviews = usedInterviews(3),
  ledger = [],
  contractStartAt = '2026-08-01T00:00:00.000Z'
} = {}) {
  return createFakeSupabase({
    clients: [{
      id: CLIENT,
      parent_client_id: null,
      stripe_customer_id: CUSTOMER,
      stripe_subscription_id: SUBSCRIPTION,
      contract_start_at: contractStartAt
    }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 0,
      usage_interview_fee_cents: unitPriceCents,
      rollover_days: 90
    }],
    roles,
    interviews,
    usage_billing_ledger: ledger,
    billing_invoices: []
  }, { unique: UNIQUE_KEYS });
}

function invoiceEvent({
  billingReason = 'subscription_cycle',
  status = 'draft',
  subscription = SUBSCRIPTION,
  customer = CUSTOMER,
  id = INVOICE
} = {}) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'invoice.created',
    created: 1788220800,
    data: {
      object: {
        id,
        object: 'invoice',
        status,
        billing_reason: billingReason,
        customer,
        subscription,
        period_start: 1785542400,
        period_end: PERIOD_END_UNIX,
        total: 120000,
        amount_due: 120000,
        lines: { data: [{ period: { end: PERIOD_END_UNIX } }] }
      }
    }
  };
}

function loadApp(event, db, { invoiceItemsCreate } = {}) {
  for (const p of [routerPath, stripeClientPath, supabasePath, activationPath]) delete require.cache[p];

  const itemCalls = [];
  injectModule(activationPath, { activatePublicPurchaseAgreementCheckout: async () => ({ ok: true }) });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => ({ id: SUBSCRIPTION, status: 'active', items: { data: [] }, metadata: {} }) },
    invoiceItems: {
      create: async (payload) => {
        itemCalls.push(payload);
        if (invoiceItemsCreate) return invoiceItemsCreate(payload, itemCalls.length);
        return { id: `ii_${itemCalls.length}` };
      }
    }
  });
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, itemCalls };
}

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

const ledgerOf = (db) => db.tables.usage_billing_ledger;

test('a draft cycle invoice gets one usage item per role, and the ledger is stamped', async () => {
  const db = makeDb({
    roles: [
      { id: 'role_1', client_id: CLIENT, title: 'Hygienist' },
      { id: 'role_2', client_id: CLIENT, title: 'Front Desk' }
    ],
    interviews: [...usedInterviews(3, { roleId: 'role_1', prefix: 'a' }), ...usedInterviews(2, { roleId: 'role_2', prefix: 'b' })]
  });
  const { app, itemCalls } = loadApp(invoiceEvent(), db);

  assert.equal((await post(app)).status, 200);

  assert.equal(itemCalls.length, 2);
  const byRole = Object.fromEntries(itemCalls.map((call) => [call.metadata.role_id, call]));
  assert.equal(byRole.role_1.quantity, 3);
  assert.equal(byRole.role_1.unit_amount, 2500);
  assert.equal(byRole.role_1.currency, 'usd');
  assert.equal(byRole.role_1.invoice, INVOICE);
  assert.equal(byRole.role_1.customer, CUSTOMER);
  assert.match(byRole.role_1.description, /^Interviews — Hygienist \(/);
  assert.equal(byRole.role_1.metadata.source, 'usage_billing');
  assert.equal(byRole.role_1.metadata.client_id, CLIENT);
  assert.equal(byRole.role_2.quantity, 2);

  assert.equal(ledgerOf(db).length, 5);
  for (const row of ledgerOf(db)) {
    assert.equal(row.stripe_invoice_id, INVOICE);
    assert.ok(row.billed_at, 'every reserved row must end up stamped');
    assert.ok(row.stripe_invoice_item_id);
    assert.equal(row.period_end, '2026-09-01T00:00:00.000Z');
  }
});

test('the period runs from the last billed period end', async () => {
  const db = makeDb({
    interviews: usedInterviews(4),
    ledger: [{
      client_id: CLIENT, role_id: 'role_1', interview_id: 'old_1', unit_price_cents: 2500,
      stripe_invoice_id: 'in_previous', billed_at: '2026-08-01T00:00:00.000Z',
      period_start: '2026-07-01T00:00:00.000Z', period_end: '2026-08-01T00:00:00.000Z'
    }]
  });
  const { app } = loadApp(invoiceEvent(), db);

  await post(app);

  const fresh = ledgerOf(db).filter((row) => row.stripe_invoice_id === INVOICE);
  assert.ok(fresh.length);
  assert.equal(fresh[0].period_start, '2026-08-01T00:00:00.000Z');
});

test('redelivery of the same invoice adds nothing', async () => {
  const db = makeDb({ interviews: usedInterviews(3) });

  const first = loadApp(invoiceEvent(), db);
  await post(first.app);
  const second = loadApp(invoiceEvent(), db);
  await post(second.app);

  assert.equal(first.itemCalls.length, 1);
  assert.equal(second.itemCalls.length, 0, 'Stripe redelivers; the client must not be charged twice');
  assert.equal(ledgerOf(db).length, 3);
});

test('a finalized invoice is left alone and the usage waits for the next cycle', async () => {
  const db = makeDb({ interviews: usedInterviews(3) });
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args);
  let itemCalls;
  try {
    const loaded = loadApp(invoiceEvent({ status: 'open' }), db);
    await post(loaded.app);
    itemCalls = loaded.itemCalls;
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(itemCalls, [], 'only a draft invoice can take items');
  assert.deepEqual(ledgerOf(db), [], 'the usage must stay unbilled, not be marked billed');
  const warned = lines.find(([message]) => message === 'usage_invoice_already_finalized');
  assert.ok(warned);
  assert.equal(warned[1].stripe_invoice_id, INVOICE);
});

test('an invoice raised for any other reason is ignored', async () => {
  for (const reason of ['subscription_create', 'manual', 'subscription_update']) {
    const db = makeDb({ interviews: usedInterviews(3) });
    const { app, itemCalls } = loadApp(invoiceEvent({ billingReason: reason }), db);

    assert.equal((await post(app)).status, 200);
    assert.deepEqual(itemCalls, [], `${reason} must not trigger usage billing`);
    assert.deepEqual(ledgerOf(db), []);
  }
});

test('a client on any other billing model is ignored', async () => {
  for (const [planTier, billingModel] of [['basic', 'fixed'], ['pro', 'rollover']]) {
    const db = makeDb({ planTier, billingModel, interviews: usedInterviews(9) });
    const { app, itemCalls } = loadApp(invoiceEvent(), db);

    assert.equal((await post(app)).status, 200);
    assert.deepEqual(itemCalls, [], `${billingModel} clients are not invoiced for usage`);
    assert.deepEqual(ledgerOf(db), []);
  }
});

test('a usage client with nothing unbilled gets no items', async () => {
  const db = makeDb({ included: 10, interviews: usedInterviews(3) });
  const { app, itemCalls } = loadApp(invoiceEvent(), db);

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(itemCalls, []);
  assert.deepEqual(ledgerOf(db), []);
});

test('the client is found by customer when the subscription id does not match', async () => {
  const db = makeDb({ interviews: usedInterviews(2) });
  const { app, itemCalls } = loadApp(invoiceEvent({ subscription: 'sub_unknown' }), db);

  assert.equal((await post(app)).status, 200);
  assert.equal(itemCalls.length, 1);
});

test('an invoice for an unknown customer is ignored', async () => {
  const db = makeDb({ interviews: usedInterviews(2) });
  const { app, itemCalls } = loadApp(
    invoiceEvent({ subscription: 'sub_unknown', customer: 'cus_unknown' }), db);

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(itemCalls, []);
});

test('a Stripe failure part-way through leaves reattachable rows and asks Stripe to retry', async () => {
  const db = makeDb({
    roles: [
      { id: 'role_1', client_id: CLIENT, title: 'Hygienist' },
      { id: 'role_2', client_id: CLIENT, title: 'Front Desk' }
    ],
    interviews: [...usedInterviews(2, { roleId: 'role_1', prefix: 'a' }), ...usedInterviews(2, { roleId: 'role_2', prefix: 'b' })]
  });

  const failing = loadApp(invoiceEvent(), db, {
    invoiceItemsCreate: (_payload, callNumber) => {
      if (callNumber === 2) throw new Error('Stripe is unavailable');
      return { id: `ii_${callNumber}` };
    }
  });
  const failedResponse = await post(failing.app);

  assert.equal(failedResponse.status, 500, 'a transient failure must let Stripe retry');
  assert.equal(ledgerOf(db).length, 4, 'all four were reserved before any item was created');
  const stamped = ledgerOf(db).filter((row) => row.billed_at != null);
  const unstamped = ledgerOf(db).filter((row) => row.billed_at == null);
  assert.equal(stamped.length, 2, 'the item that succeeded stamped its rows');
  assert.equal(unstamped.length, 2);

  // The retry must bill only what is still unstamped.
  const retry = loadApp(invoiceEvent(), db);
  assert.equal((await post(retry.app)).status, 200);

  assert.equal(retry.itemCalls.length, 1, 'only the failed line is re-created');
  assert.equal(retry.itemCalls[0].quantity, 2);
  assert.equal(ledgerOf(db).length, 4, 'no interview is billed twice');
  assert.equal(ledgerOf(db).filter((row) => row.billed_at == null).length, 0);
});

test('the transient failure is not tagged permanent, so Stripe keeps retrying', () => {
  const source = fs.readFileSync(routerPath, 'utf8');
  const handler = source.slice(
    source.indexOf('async function addUsageLinesToInvoice'),
    source.indexOf('function shouldIgnoreStaleSubscriptionUpdate')
  );
  assert.ok(handler.length, 'expected the usage handler to be present');
  assert.doesNotMatch(handler, /permanentFailure/,
    'a Stripe outage must not be acknowledged as permanent');
  assert.match(source, /event\.type === 'invoice\.created'/);
});

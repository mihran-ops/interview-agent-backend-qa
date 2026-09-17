'use strict';

// Findings-003 S1-1 and S1-2.
//
// S1-1: a checkout session only grants entitlement once Stripe says the money settled.
// checkout.session.completed can arrive with payment_status 'unpaid' for delayed payment
// methods, and used to grant regardless.
//
// S1-2: a transient processing failure must leave the event retryable — 500 so Stripe
// redelivers, and the dedupe row removed so the redelivery is not rejected as a replay.
//
// The Stripe SDK and Supabase are stubbed; no database and no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Minimal Supabase stand-in that records every write.
function makeDb(state) {
  const db = {
    writes: [],
    from(table) {
      const q = {
        _table: table,
        select() { return q; },
        eq() { return q; },
        is() { return q; },
        in() { return q; },
        not() { return q; },
        order() { return q; },
        limit() { return q; },
        insert(row) {
          db.writes.push({ op: 'insert', table, row });
          return Promise.resolve({ error: state.insertError || null });
        },
        update(row) {
          db.writes.push({ op: 'update', table, row });
          if (state.updateError && table === state.updateError.table) {
            return Promise.resolve({ data: null, error: state.updateError.error });
          }
          return q;
        },
        delete() {
          db.writes.push({ op: 'delete', table });
          return q;
        },
        upsert(row) {
          db.writes.push({ op: 'upsert', table, row });
          return Promise.resolve({ error: null });
        },
        maybeSingle() { return Promise.resolve({ data: state.rows[q._table] ?? null, error: null }); },
        then(resolve) { return resolve({ data: null, error: state.tailError || null }); },
      };
      return q;
    },
  };
  return db;
}

function loadApp(event, state) {
  for (const p of [routerPath, stripeClientPath, supabasePath]) delete require.cache[p];

  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', items: { data: [] } }) },
  });
  const db = makeDb(state);
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, db };
}

function completedSession({ type = 'checkout.session.completed', payment_status, id = 'evt_1' }) {
  return {
    id,
    type,
    data: {
      object: {
        id: 'cs_1',
        status: 'complete',
        payment_status,
        customer: 'cus_1',
        payment_intent: 'pi_1',
        metadata: {
          purchase_type: 'additional_interviews',
          role_interview_purchase_id: 'rip_1',
          client_id: 'client_1',
          role_id: 'role_1',
          quantity: '5',
        },
      },
    },
  };
}

const PENDING_PURCHASE = {
  role_interview_purchases: {
    id: 'rip_1', client_id: 'client_1', role_id: 'role_1', quantity: 5, status: 'pending',
  },
};

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

function paidUpdates(db) {
  return db.writes.filter(
    (w) => w.op === 'update' && w.table === 'role_interview_purchases' && w.row?.status === 'paid');
}

test('an unpaid completed session grants nothing', async () => {
  const { app, db } = loadApp(
    completedSession({ payment_status: 'unpaid' }), { rows: PENDING_PURCHASE });

  const res = await post(app);

  assert.equal(res.status, 200, 'the event is acknowledged, not retried');
  assert.deepEqual(paidUpdates(db), [], 'the purchase must not be marked paid before settlement');
});

test('a paid completed session still grants', async () => {
  const { app, db } = loadApp(
    completedSession({ payment_status: 'paid' }), { rows: PENDING_PURCHASE });

  const res = await post(app);

  assert.equal(res.status, 200);
  assert.equal(paidUpdates(db).length, 1, 'a settled payment must still be granted');
});

test('no_payment_required also grants', async () => {
  const { app, db } = loadApp(
    completedSession({ payment_status: 'no_payment_required' }), { rows: PENDING_PURCHASE });

  await post(app);

  assert.equal(paidUpdates(db).length, 1);
});

test('async_payment_succeeded grants the entitlement the unpaid session did not', async () => {
  const { app, db } = loadApp(
    completedSession({ type: 'checkout.session.async_payment_succeeded', payment_status: 'paid' }),
    { rows: PENDING_PURCHASE });

  const res = await post(app);

  assert.equal(res.status, 200);
  assert.equal(paidUpdates(db).length, 1);
});

test('async_payment_failed marks the purchase failed and grants nothing', async () => {
  const { app, db } = loadApp(
    completedSession({ type: 'checkout.session.async_payment_failed', payment_status: 'unpaid' }),
    { rows: PENDING_PURCHASE });

  const res = await post(app);

  assert.equal(res.status, 200);
  assert.deepEqual(paidUpdates(db), []);
  const failedUpdate = db.writes.find(
    (w) => w.op === 'update' && w.table === 'role_interview_purchases' && w.row?.status === 'failed');
  assert.ok(failedUpdate, 'a failed async payment should be recorded on the purchase');
});

test('a transient failure returns 500 and clears the dedupe row so Stripe can retry', async () => {
  // The purchase lookup succeeds, then the paid update fails with a database error,
  // which is not a validation failure and so must be treated as retryable.
  const { app, db } = loadApp(
    completedSession({ payment_status: 'paid' }),
    {
      rows: PENDING_PURCHASE,
      updateError: { table: 'role_interview_purchases', error: { message: 'connection reset' } },
    });

  const res = await post(app);

  assert.equal(res.status, 500, 'a transient failure must not be acknowledged');
  assert.equal(res.body.code, 'STRIPE_EVENT_PROCESSING_FAILED');
  const cleared = db.writes.find((w) => w.op === 'delete' && w.table === 'billing_events');
  assert.ok(cleared, 'the dedupe row must be removed or the retry is rejected as a replay');
});

test('a validation failure is acknowledged with 200 and keeps the dedupe row', async () => {
  // Metadata claims a different client than the purchase row: redelivery cannot fix this.
  const event = completedSession({ payment_status: 'paid' });
  event.data.object.metadata.client_id = 'someone_else';
  const { app, db } = loadApp(event, { rows: PENDING_PURCHASE });

  const res = await post(app);

  assert.equal(res.status, 200, 'a permanent failure must not be retried forever');
  assert.deepEqual(paidUpdates(db), []);
  assert.ok(!db.writes.some((w) => w.op === 'delete' && w.table === 'billing_events'),
    'the dedupe row stays, so a redelivery is treated as a replay');
});

test('the signature failure response carries no Stripe detail', async () => {
  for (const p of [routerPath, stripeClientPath, supabasePath]) delete require.cache[p];
  injectModule(stripeClientPath, {
    webhooks: {
      constructEvent() { throw new Error('No signatures found matching the expected signature'); },
    },
  });
  const db = makeDb({ rows: {} });
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));

  const res = await post(app);

  assert.equal(res.status, 400);
  assert.equal(res.body.detail, 'Signature verification failed.');
  assert.ok(!/signatures found/i.test(JSON.stringify(res.body)));
  assert.deepEqual(db.writes, [], 'nothing is written before the signature verifies');
});

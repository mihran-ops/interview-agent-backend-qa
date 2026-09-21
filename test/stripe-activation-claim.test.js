'use strict';

// Activation claims on public_purchase_intents must be reclaimable.
//
// The claim is taken before activation and released on failure. If the release itself
// fails, the claim is left behind and every later delivery is refused with
// activation_in_progress — the webhook answers 200, Stripe stops retrying, and nothing
// else clears it. A claim older than the stale window may therefore be taken over.
//
// The Supabase stub below evaluates the filter chain against a single row rather than
// recording it, so these tests exercise the real matching logic.

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

const MINUTE = 60 * 1000;

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Applies eq / neq / is(null) / or(...) to a candidate row the way PostgREST would.
function matches(row, filters) {
  return filters.every((f) => {
    if (f.op === 'eq') return String(row[f.column] ?? '') === String(f.value ?? '');
    if (f.op === 'neq') return String(row[f.column] ?? '') !== String(f.value ?? '');
    if (f.op === 'is') return f.value === null ? row[f.column] == null : row[f.column] === f.value;
    if (f.op === 'or') {
      return f.value.split(',').some((clause) => {
        const [column, operator, ...rest] = clause.split('.');
        const operand = rest.join('.');
        const current = row[column];
        if (operator === 'is') return operand === 'null' ? current == null : false;
        if (operator === 'lt') return current != null && String(current) < operand;
        return false;
      });
    }
    return true;
  });
}

function makeDb(intentRow) {
  const state = { intent: intentRow ? { ...intentRow } : null };
  const db = {
    state,
    from(table) {
      const filters = [];
      let pending = null;
      const q = {
        select() { return q; },
        eq(column, value) { filters.push({ op: 'eq', column, value }); return q; },
        neq(column, value) { filters.push({ op: 'neq', column, value }); return q; },
        is(column, value) { filters.push({ op: 'is', column, value }); return q; },
        or(value) { filters.push({ op: 'or', value }); return q; },
        in() { return q; },
        not() { return q; },
        order() { return q; },
        limit() { return q; },
        insert() { return Promise.resolve({ error: null }); },
        upsert() { return Promise.resolve({ error: null }); },
        delete() { return q; },
        update(row) { pending = row; return q; },
        maybeSingle() {
          if (table !== 'public_purchase_intents') return Promise.resolve({ data: null, error: null });
          const row = state.intent;
          if (!row) return Promise.resolve({ data: null, error: null });
          if (!pending) {
            return Promise.resolve({ data: matches(row, filters) ? { ...row } : null, error: null });
          }
          if (!matches(row, filters)) return Promise.resolve({ data: null, error: null });
          Object.assign(row, pending);
          return Promise.resolve({ data: { id: row.id }, error: null });
        },
        then(resolve) { return resolve({ data: null, error: null }); },
      };
      return q;
    },
  };
  return db;
}

function loadApp(intentRow) {
  for (const p of [routerPath, stripeClientPath, supabasePath, activationPath]) delete require.cache[p];

  const activationCalls = [];
  injectModule(activationPath, {
    activatePublicPurchaseAgreementCheckout: async (args) => {
      activationCalls.push(args);
      return { ok: true, status: 'activated' };
    },
  });
  injectModule(stripeClientPath, {
    webhooks: {
      constructEvent: () => ({
        id: `evt_${Math.random().toString(16).slice(2)}`,
        type: 'checkout.session.completed',
        created: 1789000000,
        data: {
          object: {
            id: 'cs_1', mode: 'subscription', status: 'complete', payment_status: 'paid',
            customer: 'cus_1', subscription: 'sub_1',
            metadata: {
              source: 'agreement_checkout', agreement_id: 'agr_1',
              client_id: 'client_1', plan_tier: 'pro', billing_interval: 'monthly',
            },
          },
        },
      }),
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active', items: { data: [] }, metadata: {} }) },
  });
  const db = makeDb(intentRow);
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, db, activationCalls };
}

const intent = (overrides = {}) => ({
  id: 'ppi_1', agreement_id: 'agr_1', status: 'pending', activated_at: null,
  canceled_at: null, activation_claimed_at: null, activation_claim_key: null,
  ...overrides,
});

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

test('an unclaimed intent is claimed and activated', async () => {
  const { app, db, activationCalls } = loadApp(intent());

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1);
  assert.ok(db.state.intent.activation_claimed_at, 'the claim should be recorded');
});

test('a fresh claim blocks a second caller', async () => {
  const heldAt = new Date(Date.now() - 2 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(
    intent({ activation_claimed_at: heldAt, activation_claim_key: 'cs_other' }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, [], 'a live claim must not be taken over');
  assert.equal(db.state.intent.activation_claim_key, 'cs_other', 'the held claim is untouched');
});

test('a sixteen-minute-old claim is taken over', async () => {
  const staleAt = new Date(Date.now() - 16 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(
    intent({ activation_claimed_at: staleAt, activation_claim_key: 'cs_abandoned' }));

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1, 'an abandoned claim must not block activation forever');
  assert.equal(db.state.intent.activation_claim_key, 'cs_1', 'the new caller owns the claim');
});

test('a claim exactly at the boundary is still treated as live', async () => {
  const boundary = new Date(Date.now() - 14 * MINUTE).toISOString();
  const { app, activationCalls } = loadApp(
    intent({ activation_claimed_at: boundary, activation_claim_key: 'cs_other' }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, [], 'inside the window the claim still holds');
});

test('a completed intent is never reclaimed', async () => {
  const staleAt = new Date(Date.now() - 60 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(intent({
    status: 'completed',
    activated_at: '2026-09-19T00:00:00.000Z',
    activation_claimed_at: staleAt,
    activation_claim_key: 'cs_done',
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.state.intent.activation_claim_key, 'cs_done',
    'a completed activation must never have its claim taken over');
});

test('a canceled intent is never claimed, however old', async () => {
  const staleAt = new Date(Date.now() - 60 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(intent({
    status: 'canceled',
    canceled_at: '2026-09-19T00:00:00.000Z',
    activation_claimed_at: staleAt,
    activation_claim_key: 'cs_canceled',
  }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, [], 'a canceled purchase must never activate');
  assert.equal(db.state.intent.activation_claim_key, 'cs_canceled');
});

test('taking over a stale claim logs the previous claim key', async () => {
  const staleAt = new Date(Date.now() - 20 * MINUTE).toISOString();
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...args) => lines.push(args);
  try {
    const { app } = loadApp(
      intent({ activation_claimed_at: staleAt, activation_claim_key: 'cs_abandoned' }));
    await post(app);
  } finally {
    console.warn = originalWarn;
  }

  const reclaimed = lines.find(([message]) => message === 'activation_claim_reclaimed');
  assert.ok(reclaimed, 'a takeover must be visible in the log');
  assert.equal(reclaimed[1].previous_claim_key, 'cs_abandoned');
  assert.equal(reclaimed[1].purchase_intent_id, 'ppi_1');
});

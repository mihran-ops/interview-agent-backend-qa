'use strict';

// PATCH /admin/clients/:id/plan-settings.
//
// Every field is optional, so the route has to tell "left out" apart from "sent
// something invalid": the first is a no-op, the second is a 400. Nothing else in
// the row may be touched.
//
// Auth, Supabase, SendGrid and the checkout service are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'admin', 'billing.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const adminHelpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const PLAN_SETTINGS_ROW = Object.freeze({
  client_id: 'client_1',
  plan_tier: 'pro',
  billing_model: 'rollover',
  billing_interval: 'monthly',
  platform_fee: 599,
  per_role_fee: 699,
  included_interviews_per_role: 30,
  additional_interview_fee: 35,
  usage_interview_fee_cents: null,
  rollover_days: 90
});

// Applies the patch to a single row so the response reflects what was written,
// and records every update for assertion.
function makeDb({ row = { ...PLAN_SETTINGS_ROW }, error = null } = {}) {
  const updates = [];
  return {
    updates,
    row,
    from(table) {
      let pending = null;
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        update(patch) { pending = patch; return query; },
        maybeSingle() {
          if (table !== 'client_plan_settings' || !pending) {
            return Promise.resolve({ data: null, error: null });
          }
          updates.push({ patch: pending, client_id: filters.client_id });
          if (error) return Promise.resolve({ data: null, error });
          if (!row || filters.client_id !== row.client_id) {
            return Promise.resolve({ data: null, error: null });
          }
          Object.assign(row, pending);
          return Promise.resolve({ data: { ...row }, error: null });
        }
      };
      return query;
    }
  };
}

function loadApp({ db = makeDb(), isChildClient = false, user = { id: 'admin_1' } } = {}) {
  for (const p of [routerPath, supabasePath, sendgridPath, checkoutPath, authPath, requireAdminPath, adminHelpersPath]) {
    delete require.cache[p];
  }

  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(sendgridPath, { sendSubscriptionCheckoutEmail: async () => ({ ok: true }) });
  injectModule(checkoutPath, { createSubscriptionCheckoutSession: async () => ({}) });
  injectModule(authPath, {
    requireAuth: (req, _res, next) => { req.user = user; next(); }
  });
  injectModule(requireAdminPath, { requireAdmin: (_req, _res, next) => next() });
  injectModule(adminHelpersPath, {
    rejectChildClientForAdminBilling: async (_req, res) => {
      if (!isChildClient) return true;
      res.status(403).json({ error: 'child_client_not_allowed' });
      return false;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/admin', require(routerPath));
  return { app, db };
}

const patch = (app, body, id = 'client_1') =>
  request(app).patch(`/admin/clients/${id}/plan-settings`).send(body);

test('the route is registered behind requireAuth and requireAdmin', () => {
  const source = fs.readFileSync(routerPath, 'utf8');
  assert.match(source, /router\.patch\('\/clients\/:id\/plan-settings', requireAuth, requireAdmin/);
});

test('a supplied billing model is written and returned', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, { billing_model: 'usage' });

  assert.equal(res.status, 200);
  assert.equal(res.body.plan_settings.billing_model, 'usage');
  assert.deepEqual(db.updates[0].patch, { billing_model: 'usage' });
  assert.equal(db.updates[0].client_id, 'client_1');
});

test('only the supplied fields are written', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, { usage_interview_fee_cents: 2500, rollover_days: 45 });

  assert.equal(res.status, 200);
  assert.deepEqual(db.updates[0].patch, { usage_interview_fee_cents: 2500, rollover_days: 45 });
  assert.equal(res.body.plan_settings.per_role_fee, 699, 'untouched pricing must survive');
  assert.equal(res.body.plan_settings.billing_model, 'rollover');
});

test('every field the plan names is accepted together', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, {
    billing_model: 'usage',
    per_role_fee: 0,
    included_interviews_per_role: 0,
    additional_interview_fee: 0,
    usage_interview_fee_cents: 3000,
    rollover_days: 120
  });

  assert.equal(res.status, 200);
  assert.deepEqual(db.updates[0].patch, {
    billing_model: 'usage',
    per_role_fee: 0,
    included_interviews_per_role: 0,
    additional_interview_fee: 0,
    usage_interview_fee_cents: 3000,
    rollover_days: 120
  }, 'zero is a real Enterprise value and must not be treated as absent');
});

test('an unknown billing model is refused', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, { billing_model: 'freebie' });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_PLAN_SETTINGS');
  assert.match(res.body.detail, /billing_model/);
  assert.deepEqual(db.updates, [], 'nothing may be written when validation fails');
});

test('negative money, fractional counts and a zero rollover window are refused', async () => {
  for (const [body, field] of [
    [{ per_role_fee: -1 }, 'per_role_fee'],
    [{ additional_interview_fee: 'free' }, 'additional_interview_fee'],
    [{ included_interviews_per_role: 2.5 }, 'included_interviews_per_role'],
    [{ included_interviews_per_role: -3 }, 'included_interviews_per_role'],
    [{ usage_interview_fee_cents: -100 }, 'usage_interview_fee_cents'],
    [{ rollover_days: 0 }, 'rollover_days'],
    [{ rollover_days: -30 }, 'rollover_days']
  ]) {
    const { app, db } = loadApp();
    const res = await patch(app, body);
    assert.equal(res.status, 400, `${field} ${JSON.stringify(body)} should be refused`);
    assert.match(res.body.detail, new RegExp(field));
    assert.deepEqual(db.updates, []);
  }
});

test('one invalid field refuses the whole request', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, { billing_model: 'usage', rollover_days: -1 });

  assert.equal(res.status, 400);
  assert.deepEqual(db.updates, [], 'a partial write would leave the row half-changed');
});

test('an empty body is refused rather than written as a no-op', async () => {
  const { app, db } = loadApp();

  const res = await patch(app, {});

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_PLAN_SETTINGS_SUPPLIED');
  assert.deepEqual(db.updates, []);
});

test('a child client is refused before anything is written', async () => {
  const { app, db } = loadApp({ isChildClient: true });

  const res = await patch(app, { billing_model: 'usage' });

  assert.equal(res.status, 403);
  assert.deepEqual(db.updates, [], 'a child client is billed under its parent');
});

test('a client with no plan settings row answers 404', async () => {
  const { app } = loadApp({ db: makeDb({ row: null }) });

  const res = await patch(app, { billing_model: 'usage' });

  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'PLAN_SETTINGS_NOT_FOUND');
});

test('a database failure answers 500 and does not claim success', async () => {
  const { app } = loadApp({ db: makeDb({ error: { message: 'connection reset' } }) });

  const res = await patch(app, { billing_model: 'usage' });

  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'PLAN_SETTINGS_UPDATE_FAILED');
});

test('the change is logged with the actor and the fields that changed', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args);
  try {
    const { app } = loadApp();
    await patch(app, { billing_model: 'usage', rollover_days: 60 });
  } finally {
    console.log = originalLog;
  }

  const logged = lines.find(([message]) => message === 'admin_plan_settings_updated');
  assert.ok(logged, 'the change must be traceable');
  assert.equal(logged[1].client_id, 'client_1');
  assert.equal(logged[1].actor_user_id, 'admin_1');
  assert.deepEqual(logged[1].changed_fields, ['billing_model', 'rollover_days']);
});

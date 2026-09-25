'use strict';

// What clients and administrators can read about credits and usage.
//
// These are read-only endpoints, so the thing worth protecting is scope: a
// client must never see another client's credits or usage. Beyond that, a client
// on a model with no credits gets an empty list rather than an error, because
// "you have none" is a normal answer, not a failure.
//
// Supabase and auth are stubbed; no database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const clientBillingPath = path.join(ROOT, 'src', 'routes', 'client', 'billing.js');
const adminBillingPath = path.join(ROOT, 'src', 'routes', 'admin', 'billing.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const adminHelpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');
const clientScopePath = path.join(ROOT, 'src', 'services', 'clientScope.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(sendgridPath, {
  sendSubscriptionCheckoutEmail: async () => ({ ok: true }),
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const MINE = 'client_1';
const THEIRS = 'client_2';

function usedInterviews(count, { clientId = MINE, roleId = 'role_1', prefix = 'iv' } = {}) {
  const start = new Date('2026-08-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: clientId,
    role_id: roleId,
    status: 'completed',
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: MINE,
  source_role_id: 'role_closed',
  quantity: 5,
  remaining: 4,
  minted_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  included = 5,
  unitPriceCents = null,
  credits = [],
  interviews = [],
  roles = [
    { id: 'role_1', client_id: MINE, title: 'Hygienist' },
    { id: 'role_closed', client_id: MINE, title: 'Receptionist' }
  ],
  ledger = []
} = {}) {
  return createFakeSupabase({
    clients: [
      { id: MINE, parent_client_id: null, name: 'Acme Dental Group' },
      { id: THEIRS, parent_client_id: null, name: 'Other Dental' }
    ],
    client_plan_settings: [
      {
        client_id: MINE, plan_tier: planTier, billing_model: billingModel,
        included_interviews_per_role: included, per_role_fee: 699,
        usage_interview_fee_cents: unitPriceCents, rollover_days: 90,
        billing_interval: 'monthly', platform_fee: 599, additional_interview_fee: 35,
        updated_at: '2026-09-01T00:00:00.000Z'
      },
      {
        client_id: THEIRS, plan_tier: 'pro', billing_model: 'rollover',
        included_interviews_per_role: 5, per_role_fee: 699,
        usage_interview_fee_cents: null, rollover_days: 90
      }
    ],
    roles,
    interviews,
    interview_credits: credits,
    interview_credit_draws: [],
    usage_billing_ledger: ledger
  });
}

// --- the client surfaces ---------------------------------------------------

function loadClientApp(db, { memberships = [MINE], isGlobalAdmin = false } = {}) {
  for (const p of [clientBillingPath, supabasePath, authPath, clientScopePath]) delete require.cache[p];

  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(authPath, {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'user_1' };
      req.isGlobalAdmin = isGlobalAdmin;
      req.isAdmin = isGlobalAdmin;
      next();
    },
    withClientScope: (req, _res, next) => {
      req.client_memberships = memberships;
      req.clientScope = { memberships };
      next();
    }
  });
  injectModule(clientScopePath, { canViewLegalBillingForClient: () => true });

  const app = express();
  app.use(express.json());
  app.use('/', require(clientBillingPath));
  return app;
}

test('a client sees its credits, soonest to expire first, with the role they came from', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_late', source_role_id: 'role_closed', remaining: 2, expires_at: '2026-12-01T00:00:00.000Z' }),
      credit({ id: 'c_soon', source_role_id: 'role_1', remaining: 3, expires_at: '2026-10-01T00:00:00.000Z' })
    ]
  });

  const res = await request(loadClientApp(db)).get('/clients/billing/credits');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((item) => item.id), ['c_soon', 'c_late']);
  assert.equal(res.body.items[0].source_role_title, 'Hygienist');
  assert.equal(res.body.items[1].source_role_title, 'Receptionist');
  assert.equal(res.body.items[0].remaining, 3);
  assert.equal(res.body.items[0].expires_at, '2026-10-01T00:00:00.000Z');
  assert.equal(res.body.total_remaining, 5);
});

test('a client on a model with no credits gets an empty list, not an error', async () => {
  for (const [planTier, billingModel] of [['basic', 'fixed'], ['enterprise', 'usage']]) {
    const db = makeDb({ planTier, billingModel });

    const res = await request(loadClientApp(db)).get('/clients/billing/credits');

    assert.equal(res.status, 200, `${billingModel} must not error`);
    assert.deepEqual(res.body, { items: [], total_remaining: 0 });
  }
});

test('expired and revoked credits are not shown', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_expired', expires_at: '2020-01-01T00:00:00.000Z' }),
      credit({ id: 'c_revoked', source_role_id: 'role_1', revoked_at: '2026-09-10T00:00:00.000Z' })
    ]
  });

  const res = await request(loadClientApp(db)).get('/clients/billing/credits');

  assert.deepEqual(res.body.items, []);
});

test('a role title is only read from the caller own roles', async () => {
  // The source role ids come from credits already scoped to the client, so this
  // is defence in depth rather than a live leak — but a title lookup with no
  // client filter is one bad credit row away from showing another client's role.
  const db = makeDb({ credits: [credit({ source_role_id: 'role_theirs' })] });
  db.tables.roles.push({ id: 'role_theirs', client_id: THEIRS, title: 'Confidential Role' });

  const res = await request(loadClientApp(db)).get('/clients/billing/credits');

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].source_role_title, null,
    'a role outside the client must not resolve to a title');
});

test('a client cannot read the credits of a client it is not a member of', async () => {
  const db = makeDb({ credits: [credit({ client_id: THEIRS, source_role_id: 'role_theirs' })] });

  const res = await request(loadClientApp(db, { memberships: [MINE] }))
    .get(`/clients/billing/credits?client_id=${THEIRS}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');
});

test('a caller with no readable clients is refused', async () => {
  const res = await request(loadClientApp(makeDb(), { memberships: [] })).get('/clients/billing/credits');

  assert.equal(res.status, 403);
});

test('a caller with several clients must say which one', async () => {
  const res = await request(loadClientApp(makeDb(), { memberships: [MINE, THEIRS] }))
    .get('/clients/billing/credits');

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'client_id_required');
});

test('a usage client sees what it has run and not yet been invoiced for', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 1, unitPriceCents: 2500,
    interviews: usedInterviews(4)
  });

  const res = await request(loadClientApp(db)).get('/clients/billing/usage');

  assert.equal(res.status, 200);
  assert.equal(res.body.billable, true);
  assert.equal(res.body.total_cents, 3 * 2500);
  assert.equal(res.body.lines[0].role_title, 'Hygienist');
  assert.equal(res.body.lines[0].quantity, 3);
});

test('a client on another model sees no usage rather than an error', async () => {
  const db = makeDb({ planTier: 'pro', billingModel: 'rollover', included: 0, interviews: usedInterviews(9) });

  const res = await request(loadClientApp(db)).get('/clients/billing/usage');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.lines, []);
  assert.equal(res.body.total_cents, 0);
  assert.equal(res.body.billable, false);
});

test('a client cannot read the usage of a client it is not a member of', async () => {
  const res = await request(loadClientApp(makeDb(), { memberships: [MINE] }))
    .get(`/clients/billing/usage?client_id=${THEIRS}`);

  assert.equal(res.status, 403);
});

test('reading usage writes nothing', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0, unitPriceCents: 2500,
    interviews: usedInterviews(3)
  });

  await request(loadClientApp(db)).get('/clients/billing/usage');

  assert.deepEqual(db.tables.usage_billing_ledger, [], 'a read must never reserve or bill anything');
  assert.deepEqual(db.calls.filter((call) => call.op !== 'select'), []);
});

// --- the admin surface -----------------------------------------------------

function loadAdminApp(db) {
  for (const p of [adminBillingPath, supabasePath, stripeClientPath, checkoutPath, authPath, requireAdminPath, adminHelpersPath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, {});
  injectModule(checkoutPath, { createSubscriptionCheckoutSession: async () => ({}) });
  injectModule(authPath, { requireAuth: (req, _res, next) => { req.user = { id: 'admin_1' }; next(); } });
  injectModule(requireAdminPath, { requireAdmin: (_req, _res, next) => next() });
  injectModule(adminHelpersPath, { rejectChildClientForAdminBilling: async () => true });

  const app = express();
  app.use(express.json());
  app.use('/admin', require(adminBillingPath));
  return app;
}

test('the admin summary answers billing model, pricing, credits and unbilled usage in one call', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 1, unitPriceCents: 2500,
    interviews: usedInterviews(4),
    credits: [credit({ remaining: 2 })]
  });

  const res = await request(loadAdminApp(db)).get(`/admin/clients/${MINE}/billing-summary`);

  assert.equal(res.status, 200);
  assert.equal(res.body.billing_model, 'usage');
  assert.equal(res.body.plan_settings.usage_interview_fee_cents, 2500);
  assert.equal(res.body.plan_settings.rollover_days, 90);
  assert.equal(res.body.unbilled_usage.total_cents, 3 * 2500);
  assert.equal(res.body.credits.total_remaining, 2);
});

test('the admin summary groups past usage by invoice, newest first', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 0, unitPriceCents: 2500,
    ledger: [
      { client_id: MINE, role_id: 'role_1', interview_id: 'a1', unit_price_cents: 2500, stripe_invoice_id: 'in_old', billed_at: '2026-07-01T00:00:00.000Z', period_end: '2026-07-01T00:00:00.000Z' },
      { client_id: MINE, role_id: 'role_1', interview_id: 'a2', unit_price_cents: 2500, stripe_invoice_id: 'in_old', billed_at: '2026-07-01T00:00:00.000Z', period_end: '2026-07-01T00:00:00.000Z' },
      { client_id: MINE, role_id: 'role_1', interview_id: 'b1', unit_price_cents: 3000, stripe_invoice_id: 'in_new', billed_at: '2026-08-01T00:00:00.000Z', period_end: '2026-08-01T00:00:00.000Z' },
      { client_id: MINE, role_id: 'role_1', interview_id: 'c1', unit_price_cents: 2500, stripe_invoice_id: null, billed_at: null }
    ]
  });

  const res = await request(loadAdminApp(db)).get(`/admin/clients/${MINE}/billing-summary`);

  assert.deepEqual(res.body.recent_usage_invoices.map((invoice) => invoice.stripe_invoice_id), ['in_new', 'in_old']);
  assert.equal(res.body.recent_usage_invoices[0].interviews, 1);
  assert.equal(res.body.recent_usage_invoices[0].amount_cents, 3000);
  assert.equal(res.body.recent_usage_invoices[1].interviews, 2);
  assert.equal(res.body.recent_usage_invoices[1].amount_cents, 5000);
});

test('the admin summary caps the invoice history at twelve', async () => {
  const ledger = Array.from({ length: 20 }, (_, i) => ({
    client_id: MINE, role_id: 'role_1', interview_id: `iv_${i}`, unit_price_cents: 100,
    stripe_invoice_id: `in_${String(i).padStart(2, '0')}`,
    billed_at: `2026-${String((i % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`
  }));
  const db = makeDb({ planTier: 'enterprise', billingModel: 'usage', included: 0, unitPriceCents: 2500, ledger });

  const res = await request(loadAdminApp(db)).get(`/admin/clients/${MINE}/billing-summary`);

  assert.equal(res.body.recent_usage_invoices.length, 12);
});

test('the admin summary works for a client with nothing at all', async () => {
  const db = makeDb({ planTier: 'basic', billingModel: 'fixed', roles: [], interviews: [] });

  const res = await request(loadAdminApp(db)).get(`/admin/clients/${MINE}/billing-summary`);

  assert.equal(res.status, 200);
  assert.equal(res.body.billing_model, 'fixed');
  assert.deepEqual(res.body.credits.items, []);
  assert.deepEqual(res.body.unbilled_usage.lines, []);
  assert.deepEqual(res.body.recent_usage_invoices, []);
});

// --- the payload and the registrations -------------------------------------

test('GET /roles carries the new availability keys through to the payload', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'client', 'roles.js'), 'utf8');
  for (const key of ['own_remaining_interviews', 'credit_interviews', 'billing_model']) {
    assert.match(
      source,
      new RegExp(`${key}: availability\\?\\.${key}`),
      `GET /roles must expose ${key}`
    );
  }
});

test('the three read routes are registered with the auth they need', () => {
  const clientSource = fs.readFileSync(clientBillingPath, 'utf8');
  assert.match(clientSource, /router\.get\('\/clients\/billing\/credits', requireAuth, withClientScope/);
  assert.match(clientSource, /router\.get\('\/clients\/billing\/usage', requireAuth, withClientScope/);

  const adminSource = fs.readFileSync(adminBillingPath, 'utf8');
  assert.match(adminSource, /router\.get\('\/clients\/:id\/billing-summary', requireAuth, requireAdmin/);

  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  for (const route of [
    'GET /clients/billing/credits',
    'GET /clients/billing/usage',
    'GET /admin/clients/:id/billing-summary'
  ]) {
    assert.ok(inventory.includes(route), `${route} must be in the route inventory`);
  }
});

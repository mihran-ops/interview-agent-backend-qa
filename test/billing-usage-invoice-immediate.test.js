'use strict';

// On-demand usage invoices, and the monthly cron for annual Enterprise clients.
//
// Both spend money, so the guards are the point: the admin route will not raise
// two invoices for one Idempotency-Key, and the cron picks exactly the clients
// whose anniversary is today and nothing else.
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
const adminBillingPath = path.join(ROOT, 'src', 'routes', 'admin', 'billing.js');
const internalUsagePath = path.join(ROOT, 'src', 'routes', 'internal', 'usageBilling.js');
const usageBillingPath = path.join(ROOT, 'src', 'services', 'usageBilling.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const adminHelpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(sendgridPath, {
  sendSubscriptionCheckoutEmail: async () => ({ ok: true }),
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const CLIENT = 'client_1';
const CUSTOMER = 'cus_1';
const ADMIN = 'admin_1';
const NOW = '2026-09-15T12:00:00.000Z';

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`,
  billing_idempotency_keys: (row) => `${row.actor_user_id}|${row.route_key}|${row.idempotency_key}`
};

function usedInterviews(count, { clientId = CLIENT, roleId = 'role_1', prefix = 'iv' } = {}) {
  const start = new Date('2026-08-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: clientId,
    role_id: roleId,
    status: 'completed',
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

function makeStripe({ failFinalize = false, failDelete = false } = {}) {
  const calls = { invoices: [], items: [], finalized: [], deleted: [] };
  return {
    calls,
    invoices: {
      create: async (payload) => {
        calls.invoices.push(payload);
        return { id: `in_${calls.invoices.length}` };
      },
      finalizeInvoice: async (id) => {
        if (failFinalize) throw new Error('Stripe is unavailable');
        calls.finalized.push(id);
        return { id, status: 'open' };
      },
      del: async (id) => {
        if (failDelete) throw new Error('Stripe is unavailable');
        calls.deleted.push(id);
        return { id, deleted: true };
      }
    },
    invoiceItems: {
      create: async (payload) => {
        calls.items.push(payload);
        return { id: `ii_${calls.items.length}` };
      }
    }
  };
}

function makeDb({
  clients = [{
    id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
    stripe_customer_id: CUSTOMER, billing_interval: 'annual',
    contract_start_at: '2025-09-15T00:00:00.000Z', current_term_end: '2026-09-15T00:00:00.000Z'
  }],
  planSettings = [{
    client_id: CLIENT, plan_tier: 'enterprise', billing_model: 'usage',
    included_interviews_per_role: 0, per_role_fee: 0,
    usage_interview_fee_cents: 2500, rollover_days: 90
  }],
  roles = [{ id: 'role_1', client_id: CLIENT, title: 'Hygienist' }],
  interviews = usedInterviews(3),
  ledger = [],
  idempotency = []
} = {}) {
  return createFakeSupabase({
    clients,
    client_plan_settings: planSettings,
    roles,
    interviews,
    usage_billing_ledger: ledger,
    billing_idempotency_keys: idempotency
  }, { unique: UNIQUE_KEYS });
}

// --- the service -----------------------------------------------------------

function loadService() {
  for (const p of [usageBillingPath, supabasePath]) delete require.cache[p];
  injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });
  return require(usageBillingPath);
}

const { createImmediateUsageInvoice, isAnniversaryToday, anniversaryDayOfMonth } = loadService();

test('an immediate invoice bills the unbilled usage and finalizes', async () => {
  const db = makeDb({ interviews: usedInterviews(4) });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({
    db, stripe, clientId: CLIENT, periodEnd: NOW, reason: 'admin_request', now: NOW
  });

  assert.equal(result.invoice_id, 'in_1');
  assert.equal(result.total_cents, 4 * 2500);
  assert.equal(stripe.calls.invoices[0].customer, CUSTOMER);
  assert.equal(stripe.calls.invoices[0].collection_method, 'charge_automatically');
  assert.equal(stripe.calls.invoices[0].auto_advance, true);
  assert.equal(stripe.calls.invoices[0].metadata.source, 'usage_billing');
  assert.equal(stripe.calls.invoices[0].metadata.reason, 'admin_request');
  assert.equal(stripe.calls.items.length, 1);
  assert.equal(stripe.calls.items[0].quantity, 4);
  assert.deepEqual(stripe.calls.finalized, ['in_1']);
  assert.equal(db.tables.usage_billing_ledger.length, 4);
  assert.ok(db.tables.usage_billing_ledger.every((row) => row.billed_at));
});

test('a client with nothing unbilled is skipped without touching Stripe', async () => {
  const db = makeDb({
    planSettings: [{
      client_id: CLIENT, plan_tier: 'enterprise', billing_model: 'usage',
      included_interviews_per_role: 10, per_role_fee: 0,
      usage_interview_fee_cents: 2500, rollover_days: 90
    }]
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, periodEnd: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.deepEqual(stripe.calls.invoices, [], 'an empty invoice must never be raised');
});

test('a client on another billing model is skipped', async () => {
  const db = makeDb({
    planSettings: [{
      client_id: CLIENT, plan_tier: 'pro', billing_model: 'rollover',
      included_interviews_per_role: 0, per_role_fee: 699,
      usage_interview_fee_cents: null, rollover_days: 90
    }]
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, periodEnd: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'billing_model');
});

test('a client with no Stripe customer is skipped rather than half invoiced', async () => {
  const db = makeDb({
    clients: [{ id: CLIENT, parent_client_id: null, stripe_customer_id: null, billing_interval: 'annual' }]
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, periodEnd: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_stripe_customer');
  assert.deepEqual(db.tables.usage_billing_ledger, []);
});

// There is unbilled usage, so an invoice is created — but the id it comes back
// with already carries fully stamped ledger rows, so applyUsageToInvoice adds
// nothing. Finalizing then would send an empty invoice, and auto_advance would
// try to collect it.
const ALREADY_BILLED = Object.freeze({
  interviews: [
    { id: 'iv_1', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-01T00:00:00.000Z' },
    { id: 'iv_2', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-02T00:00:00.000Z' },
    { id: 'iv_3', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-03T00:00:00.000Z' }
  ],
  ledger: [
    { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_1', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: '2026-09-01T00:00:00.000Z' },
    { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_2', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: '2026-09-01T00:00:00.000Z' }
  ]
});

test('an invoice that ends up with no lines is discarded, not finalized', async () => {
  const db = makeDb({ ...ALREADY_BILLED });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({
    db, stripe, clientId: CLIENT, periodEnd: NOW, reason: 'admin_request', now: NOW
  });

  assert.equal(result.skipped, true);
  assert.equal(stripe.calls.invoices.length, 1, 'the draft was created before we knew it would be empty');
  assert.deepEqual(stripe.calls.items, [], 'nothing was added to it');
  assert.deepEqual(stripe.calls.finalized, [], 'an empty invoice must never be finalized');
  assert.deepEqual(stripe.calls.deleted, ['in_1'], 'the draft must be discarded');
});

test('a failed discard is logged and still reports skipped rather than charging', async () => {
  const db = makeDb({ ...ALREADY_BILLED });
  const stripe = makeStripe({ failDelete: true });
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args);
  let result;
  try {
    result = await createImmediateUsageInvoice({
      db, stripe, clientId: CLIENT, periodEnd: NOW, reason: 'admin_request', now: NOW
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.skipped, true);
  assert.deepEqual(stripe.calls.finalized, [], 'a cleanup failure must not fall through to finalize');
  assert.ok(lines.find(([message]) => message === 'usage_invoice_discard_failed'));
});

// --- the anniversary ------------------------------------------------------

test('the anniversary day comes from the subscription start', () => {
  assert.equal(anniversaryDayOfMonth({ contract_start_at: '2025-03-17T00:00:00.000Z' }), 17);
  assert.equal(
    anniversaryDayOfMonth({ contract_start_at: null, current_term_end: '2026-06-09T00:00:00.000Z' }), 9,
    'the term end is the fallback anchor'
  );
  assert.equal(anniversaryDayOfMonth({}), null);
});

test('a client is due only on its own anniversary day', () => {
  const client = { contract_start_at: '2025-03-17T00:00:00.000Z' };
  assert.equal(isAnniversaryToday(client, new Date('2026-09-17T08:00:00.000Z')), true);
  assert.equal(isAnniversaryToday(client, new Date('2026-09-16T08:00:00.000Z')), false);
  assert.equal(isAnniversaryToday(client, new Date('2026-09-18T08:00:00.000Z')), false);
});

test('a client anchored to the 31st runs on the last day of a shorter month', () => {
  const client = { contract_start_at: '2025-01-31T00:00:00.000Z' };
  assert.equal(isAnniversaryToday(client, new Date('2026-04-30T08:00:00.000Z')), true, 'April has 30 days');
  assert.equal(isAnniversaryToday(client, new Date('2026-04-29T08:00:00.000Z')), false);
  assert.equal(isAnniversaryToday(client, new Date('2026-02-28T08:00:00.000Z')), true, 'February 2026 has 28 days');
  assert.equal(isAnniversaryToday(client, new Date('2026-03-31T08:00:00.000Z')), true, 'March has 31 days');
  assert.equal(isAnniversaryToday(client, new Date('2026-03-30T08:00:00.000Z')), false);
});

test('a client with no anchor is never due', () => {
  assert.equal(isAnniversaryToday({}, new Date(NOW)), false);
});

// --- the cron route --------------------------------------------------------

function loadCron(db, stripe) {
  for (const p of [internalUsagePath, usageBillingPath, supabasePath, stripeClientPath]) delete require.cache[p];
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, stripe);

  const app = express();
  app.use(express.json());
  app.use('/internal', require(internalUsagePath));
  return app;
}

const CRON_SECRET = 'usage-cron-secret-value';

function withCronSecret(fn) {
  const previous = process.env.USAGE_BILLING_CRON_SECRET;
  process.env.USAGE_BILLING_CRON_SECRET = CRON_SECRET;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.USAGE_BILLING_CRON_SECRET;
    else process.env.USAGE_BILLING_CRON_SECRET = previous;
  });
}

const runCron = (app, secret = CRON_SECRET) =>
  request(app).post('/internal/billing/usage-invoices').set('x-cron-secret', secret).send({});

test('the cron refuses a wrong or missing secret', async () => {
  await withCronSecret(async () => {
    const app = loadCron(makeDb(), makeStripe());
    assert.equal((await runCron(app, 'wrong-secret-value')).status, 403);
    assert.equal((await request(app).post('/internal/billing/usage-invoices').send({})).status, 403);
  });
});

test('the cron invoices an annual usage client on its anniversary', async () => {
  await withCronSecret(async () => {
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
        stripe_customer_id: CUSTOMER, billing_interval: 'annual',
        contract_start_at: `2025-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-${String(new Date().getUTCDate()).padStart(2, '0')}T00:00:00.000Z`
      }],
      interviews: usedInterviews(2)
    });
    const stripe = makeStripe();
    const app = loadCron(db, stripe);

    const res = await runCron(app);

    assert.equal(res.status, 200);
    assert.equal(res.body.invoiced, 1);
    assert.equal(res.body.total_cents, 5000);
    assert.equal(stripe.calls.invoices[0].metadata.reason, 'monthly_cycle');
  });
});

test('monthly clients are excluded — their usage rides the cycle invoice', async () => {
  await withCronSecret(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER,
        billing_interval: 'monthly', contract_start_at: anchor
      }],
      interviews: usedInterviews(3)
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.body.considered, 0);
    assert.deepEqual(stripe.calls.invoices, []);
  });
});

test('clients on other billing models are never considered', async () => {
  await withCronSecret(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER,
        billing_interval: 'annual', contract_start_at: anchor
      }],
      planSettings: [{
        client_id: CLIENT, plan_tier: 'pro', billing_model: 'rollover',
        included_interviews_per_role: 0, per_role_fee: 699,
        usage_interview_fee_cents: null, rollover_days: 90
      }],
      interviews: usedInterviews(3)
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.body.considered, 0);
    assert.deepEqual(stripe.calls.invoices, []);
  });
});

test('a client whose anniversary is not today is not invoiced', async () => {
  await withCronSecret(async () => {
    const today = new Date();
    const notToday = today.getUTCDate() === 1 ? 2 : 1;
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER,
        billing_interval: 'annual',
        contract_start_at: `2025-06-${String(notToday).padStart(2, '0')}T00:00:00.000Z`
      }],
      interviews: usedInterviews(3)
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.body.considered, 0);
    assert.deepEqual(stripe.calls.invoices, []);
  });
});

test('one failing client does not stop the rest of the run', async () => {
  await withCronSecret(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [
        { id: 'client_bad', parent_client_id: null, stripe_customer_id: 'cus_bad', billing_interval: 'annual', contract_start_at: anchor },
        { id: 'client_good', parent_client_id: null, stripe_customer_id: 'cus_good', billing_interval: 'annual', contract_start_at: anchor }
      ],
      planSettings: [
        { client_id: 'client_bad', plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0, per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90 },
        { client_id: 'client_good', plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0, per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90 }
      ],
      roles: [
        { id: 'role_bad', client_id: 'client_bad', title: 'Hygienist' },
        { id: 'role_good', client_id: 'client_good', title: 'Front Desk' }
      ],
      interviews: [
        ...usedInterviews(2, { clientId: 'client_bad', roleId: 'role_bad', prefix: 'bad' }),
        ...usedInterviews(3, { clientId: 'client_good', roleId: 'role_good', prefix: 'good' })
      ]
    });
    const stripe = makeStripe();
    const originalCreate = stripe.invoices.create;
    stripe.invoices.create = async (payload) => {
      if (payload.customer === 'cus_bad') throw new Error('Stripe is unavailable');
      return originalCreate(payload);
    };

    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
      res = await runCron(loadCron(db, stripe));
    } finally {
      console.error = originalError;
    }

    assert.equal(res.status, 200);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.invoiced, 1);
    assert.equal(res.body.total_cents, 7500);
    const failed = res.body.results.find((entry) => entry.status === 'failed');
    assert.equal(failed.client_id, 'client_bad');
  });
});

test('the cron uses the same secret shape as the other internal routes', () => {
  const source = fs.readFileSync(internalUsagePath, 'utf8');
  assert.match(source, /process\.env\.USAGE_BILLING_CRON_SECRET/);
  assert.match(source, /req\.get\('x-cron-secret'\)/);
  assert.match(source, /secretsMatch\(providedSecret, expectedSecret\)/,
    'the comparison must be the timing-safe one the other cron routes use');
  assert.match(source, /res\.status\(403\)\.json\(\{ error: 'forbidden' \}\)/);
});

// --- the admin route -------------------------------------------------------

function loadAdmin(db, stripe, { isChildClient = false, user = { id: ADMIN } } = {}) {
  for (const p of [adminBillingPath, usageBillingPath, supabasePath, stripeClientPath, checkoutPath, authPath, requireAdminPath, adminHelpersPath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, stripe);
  injectModule(checkoutPath, { createSubscriptionCheckoutSession: async () => ({}) });
  injectModule(authPath, { requireAuth: (req, _res, next) => { req.user = user; next(); } });
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
  app.use('/admin', require(adminBillingPath));
  return app;
}

const postUsageInvoice = (app, key, body = {}) => {
  const req = request(app).post(`/admin/clients/${CLIENT}/usage-invoice`);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

test('an admin can raise a usage invoice on demand', async () => {
  const db = makeDb({ interviews: usedInterviews(3) });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let res;
  try {
    res = await postUsageInvoice(loadAdmin(db, stripe), 'usage-invoice-key-1');
  } finally {
    console.log = originalLog;
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total_cents, 7500);
  assert.equal(stripe.calls.invoices[0].metadata.reason, 'admin_request');
});

test('the Idempotency-Key header is required and must be well formed', async () => {
  const stripe = makeStripe();
  const app = loadAdmin(makeDb(), stripe);

  for (const key of [null, 'short', 'has spaces in it', 'x'.repeat(256)]) {
    const res = await postUsageInvoice(app, key);
    assert.equal(res.status, 400, `key ${JSON.stringify(key)} should be refused`);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  assert.deepEqual(stripe.calls.invoices, [], 'a malformed key must not spend money');
});

test('reusing a key with the same body replays the first answer', async () => {
  const db = makeDb({ interviews: usedInterviews(3) });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let first;
  let second;
  try {
    const app = loadAdmin(db, stripe);
    first = await postUsageInvoice(app, 'usage-invoice-key-2');
    second = await postUsageInvoice(app, 'usage-invoice-key-2');
  } finally {
    console.log = originalLog;
  }

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body, 'a double submit must return the first answer');
  assert.equal(stripe.calls.invoices.length, 1, 'and must not raise a second invoice');
});

test('reusing a key with a different body is refused', async () => {
  const db = makeDb({ interviews: usedInterviews(3) });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let second;
  try {
    const app = loadAdmin(db, stripe);
    await postUsageInvoice(app, 'usage-invoice-key-3', { period_end: '2026-09-01T00:00:00.000Z' });
    second = await postUsageInvoice(app, 'usage-invoice-key-3', { period_end: '2026-10-01T00:00:00.000Z' });
  } finally {
    console.log = originalLog;
  }

  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(stripe.calls.invoices.length, 1);
});

test('a key seen while the first call is still running is refused', async () => {
  const db = makeDb({
    interviews: usedInterviews(3),
    idempotency: [{
      actor_user_id: ADMIN,
      route_key: 'POST:/admin/clients/:id/usage-invoice',
      idempotency_key: 'usage-invoice-key-4',
      request_fingerprint: require('node:crypto')
        .createHash('sha256')
        .update(JSON.stringify({ client_id: CLIENT, period_end: null }))
        .digest('hex'),
      response_status: null,
      response_body: null
    }]
  });
  const stripe = makeStripe();

  const res = await postUsageInvoice(loadAdmin(db, stripe), 'usage-invoice-key-4');

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'REQUEST_IN_PROGRESS');
  assert.deepEqual(stripe.calls.invoices, []);
});

test('a child client is refused', async () => {
  const stripe = makeStripe();

  const res = await postUsageInvoice(loadAdmin(makeDb(), stripe, { isChildClient: true }), 'usage-invoice-key-5');

  assert.equal(res.status, 403);
  assert.deepEqual(stripe.calls.invoices, []);
});

test('both new routes are registered with the auth they need', () => {
  const adminSource = fs.readFileSync(adminBillingPath, 'utf8');
  assert.match(adminSource, /router\.post\('\/clients\/:id\/usage-invoice', requireAuth, requireAdmin/);

  const internalIndex = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'internal', 'index.js'), 'utf8');
  assert.match(internalIndex, /require\('\.\/usageBilling'\)/, 'the cron route must be mounted');

  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  assert.ok(inventory.includes('POST /admin/clients/:id/usage-invoice'));
  assert.ok(inventory.includes('POST /internal/billing/usage-invoices'));
});

test('the idempotency migration mirrors the sales one', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260921150000_billing_idempotency_keys.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.billing_idempotency_keys/i);
  assert.match(sql, /primary key \(actor_user_id, route_key, idempotency_key\)/i,
    'the primary key is what makes a concurrent duplicate fail rather than run twice');
  assert.match(sql, /request_fingerprint text not null/i);
  assert.match(sql, /alter table public\.billing_idempotency_keys enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.billing_idempotency_keys\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.billing_idempotency_keys\s*\n?to service_role/i);
});

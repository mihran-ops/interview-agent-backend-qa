'use strict';

// The Enterprise usage ledger: what is owed, and recording it.
//
// The money questions this protects: each role's included count is free, an
// interview is billed once and only once however many cycles run, and a client
// on any other model is never billed for usage. No Stripe here — Step 5 does
// that — so these tests are pure arithmetic over stubbed rows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });
injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const {
  computeUnbilledUsage,
  recordUsageLines
} = require(path.join(ROOT, 'src', 'services', 'usageBilling.js'));

const CLIENT = 'client_1';
const PERIOD_START = '2026-08-01T00:00:00.000Z';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`
};

function makeDb({
  planTier = 'enterprise',
  billingModel = 'usage',
  included = 0,
  unitPriceCents = 2500,
  roles = [{ id: 'role_1', client_id: CLIENT, title: 'Hygienist' }],
  interviews = [],
  ledger = []
} = {}) {
  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null }],
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
    usage_billing_ledger: ledger
  }, { unique: UNIQUE_KEYS });
}

// Used interviews, oldest first, one day apart inside the period.
function usedInterviews(count, { roleId = 'role_1', prefix = 'iv', from = '2026-08-01T00:00:00.000Z' } = {}) {
  const start = new Date(from).getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: CLIENT,
    role_id: roleId,
    status: 'completed',
    updated_at: new Date(start + i * 86400000).toISOString()
  }));
}

const compute = (db, periodEnd = PERIOD_END) =>
  computeUnbilledUsage({ db, clientId: CLIENT, periodEnd });

// --- what is billable ------------------------------------------------------

test('with no included interviews every used interview is billed', async () => {
  const db = makeDb({ included: 0, interviews: usedInterviews(3) });

  const usage = await compute(db);

  assert.equal(usage.lines.length, 1);
  assert.equal(usage.lines[0].quantity, 3);
  assert.equal(usage.lines[0].unit_price_cents, 2500);
  assert.equal(usage.lines[0].amount_cents, 7500);
  assert.equal(usage.total_cents, 7500);
  assert.equal(usage.lines[0].role_title, 'Hygienist');
});

test('the included count is free, per role', async () => {
  const db = makeDb({
    included: 2,
    roles: [
      { id: 'role_1', client_id: CLIENT, title: 'Hygienist' },
      { id: 'role_2', client_id: CLIENT, title: 'Front Desk' }
    ],
    interviews: [
      ...usedInterviews(5, { roleId: 'role_1', prefix: 'a' }),
      ...usedInterviews(3, { roleId: 'role_2', prefix: 'b' })
    ]
  });

  const usage = await compute(db);

  const byRole = Object.fromEntries(usage.lines.map((line) => [line.role_id, line]));
  assert.equal(byRole.role_1.quantity, 3, '5 used less 2 included');
  assert.equal(byRole.role_2.quantity, 1, '3 used less 2 included');
  assert.equal(usage.total_cents, 4 * 2500, 'the allowance is per role, not per client');
});

test('a role inside its included count contributes no line at all', async () => {
  const db = makeDb({
    included: 5,
    roles: [
      { id: 'role_1', client_id: CLIENT, title: 'Hygienist' },
      { id: 'role_2', client_id: CLIENT, title: 'Front Desk' }
    ],
    interviews: [
      ...usedInterviews(2, { roleId: 'role_1', prefix: 'a' }),
      ...usedInterviews(7, { roleId: 'role_2', prefix: 'b' })
    ]
  });

  const usage = await compute(db);

  assert.deepEqual(usage.lines.map((line) => line.role_id), ['role_2']);
  assert.equal(usage.lines[0].quantity, 2);
});

test('interviews that never became used are not billed', async () => {
  const db = makeDb({
    included: 0,
    interviews: [
      ...usedInterviews(2),
      { id: 'iv_started', client_id: CLIENT, role_id: 'role_1', status: 'Started', updated_at: PERIOD_START },
      {
        id: 'iv_no_substance',
        client_id: CLIENT,
        role_id: 'role_1',
        status: 'completed',
        has_substantive_response: false,
        conversation_progress_state: 'NoSubstantiveCandidateResponse',
        updated_at: PERIOD_START
      }
    ]
  });

  const usage = await compute(db);

  assert.equal(usage.lines[0].quantity, 2, 'a candidate who said nothing substantive is not a billable interview');
});

test('interviews after the period end wait for the next cycle', async () => {
  const db = makeDb({
    included: 0,
    interviews: [
      ...usedInterviews(2, { from: '2026-08-01T00:00:00.000Z' }),
      ...usedInterviews(2, { prefix: 'late', from: '2026-09-15T00:00:00.000Z' })
    ]
  });

  const usage = await compute(db, PERIOD_END);

  assert.equal(usage.lines[0].quantity, 2);
  assert.deepEqual(usage.lines[0].interview_ids.sort(), ['iv_1', 'iv_2']);
});

test('the interviews chosen are the newest unbilled ones', async () => {
  const db = makeDb({ included: 2, interviews: usedInterviews(5) });

  const usage = await compute(db);

  assert.deepEqual(usage.lines[0].interview_ids, ['iv_5', 'iv_4', 'iv_3']);
});

// --- not billing twice -----------------------------------------------------

test('interviews already on the ledger are not billed again', async () => {
  const db = makeDb({
    included: 0,
    interviews: usedInterviews(5),
    ledger: [
      { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_1', unit_price_cents: 2500 },
      { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_2', unit_price_cents: 2500 }
    ]
  });

  const usage = await compute(db);

  assert.equal(usage.lines[0].quantity, 3);
  assert.deepEqual(usage.lines[0].interview_ids.sort(), ['iv_3', 'iv_4', 'iv_5']);
});

test('a second cycle with no new interviews owes nothing', async () => {
  const db = makeDb({
    included: 1,
    interviews: usedInterviews(4),
    ledger: usedInterviews(3, { prefix: 'iv' }).slice(1).map((row) => ({
      client_id: CLIENT, role_id: 'role_1', interview_id: row.id, unit_price_cents: 2500
    }))
  });

  // 4 used, 1 included, 2 already ledgered — the fourth is still owed.
  const first = await compute(db);
  assert.equal(first.lines[0].quantity, 1);

  await recordUsageLines({
    db, clientId: CLIENT, lines: first.lines,
    stripeInvoiceId: 'in_1', periodStart: PERIOD_START, periodEnd: PERIOD_END
  });

  const second = await compute(db);
  assert.deepEqual(second.lines, [], 'running the same period twice must not bill twice');
  assert.equal(second.total_cents, 0);
});

test('a full period run is idempotent end to end', async () => {
  const db = makeDb({ included: 2, interviews: usedInterviews(6) });

  const first = await compute(db);
  const firstWrite = await recordUsageLines({
    db, clientId: CLIENT, lines: first.lines,
    stripeInvoiceId: 'in_1', periodStart: PERIOD_START, periodEnd: PERIOD_END
  });
  const secondWrite = await recordUsageLines({
    db, clientId: CLIENT, lines: first.lines,
    stripeInvoiceId: 'in_1', periodStart: PERIOD_START, periodEnd: PERIOD_END
  });

  assert.equal(first.lines[0].quantity, 4);
  assert.equal(firstWrite.inserted, 4);
  assert.equal(secondWrite.inserted, 0, 'a redelivered invoice writes nothing new');
  assert.equal(db.tables.usage_billing_ledger.length, 4);
});

// --- who is billed ---------------------------------------------------------

test('an Essentials client is never billed for usage', async () => {
  const db = makeDb({ planTier: 'basic', billingModel: 'fixed', included: 0, interviews: usedInterviews(9) });

  const usage = await compute(db);

  assert.deepEqual(usage.lines, []);
  assert.equal(usage.reason, 'billing_model');
});

test('a Pro client is never billed for usage', async () => {
  const db = makeDb({ planTier: 'pro', billingModel: 'rollover', included: 0, interviews: usedInterviews(9) });

  const usage = await compute(db);

  assert.deepEqual(usage.lines, []);
  assert.equal(usage.reason, 'billing_model');
});

test('an Enterprise client with no per-interview price is billed nothing', async () => {
  const db = makeDb({ unitPriceCents: null, included: 0, interviews: usedInterviews(5) });

  const usage = await compute(db);

  assert.deepEqual(usage.lines, [], 'guessing a price would be worse than billing nothing');
  assert.equal(usage.reason, 'no_usage_price');
});

test('a zero per-interview price produces lines that cost nothing', async () => {
  const db = makeDb({ unitPriceCents: 0, included: 0, interviews: usedInterviews(3) });

  const usage = await compute(db);

  assert.equal(usage.lines[0].quantity, 3);
  assert.equal(usage.total_cents, 0);
});

test('a client with no roles owes nothing', async () => {
  const db = makeDb({ roles: [], interviews: usedInterviews(5) });

  const usage = await compute(db);

  assert.deepEqual(usage.lines, []);
  assert.equal(usage.reason, 'no_roles');
});

test('the roles and interviews of another client are never included', async () => {
  const db = makeDb({
    included: 0,
    roles: [{ id: 'role_1', client_id: CLIENT, title: 'Hygienist' }],
    interviews: [
      ...usedInterviews(2),
      { id: 'other_1', client_id: 'client_2', role_id: 'role_x', status: 'completed', updated_at: PERIOD_START }
    ]
  });

  const usage = await compute(db);

  assert.equal(usage.lines[0].quantity, 2);
});

test('missing arguments are refused without touching the database', async () => {
  assert.equal((await computeUnbilledUsage({ db: null, clientId: CLIENT })).reason, 'invalid_request');
  assert.equal((await computeUnbilledUsage({ db: makeDb(), clientId: '' })).reason, 'invalid_request');
});

// --- recording -------------------------------------------------------------

test('a recorded row carries the invoice, the period and no billed_at', async () => {
  const db = makeDb({ included: 0, interviews: usedInterviews(2) });

  const usage = await compute(db);
  const written = await recordUsageLines({
    db, clientId: CLIENT, lines: usage.lines,
    stripeInvoiceId: 'in_1', periodStart: PERIOD_START, periodEnd: PERIOD_END
  });

  assert.equal(written.inserted, 2);
  const row = db.tables.usage_billing_ledger[0];
  assert.equal(row.client_id, CLIENT);
  assert.equal(row.role_id, 'role_1');
  assert.equal(row.unit_price_cents, 2500);
  assert.equal(row.stripe_invoice_id, 'in_1');
  assert.equal(row.period_start, PERIOD_START);
  assert.equal(row.period_end, PERIOD_END);
  assert.equal(row.billed_at, null, 'billed_at is stamped once the Stripe item exists');
});

test('recording nothing writes nothing', async () => {
  const db = makeDb();

  assert.deepEqual(await recordUsageLines({ db, clientId: CLIENT, lines: [] }), { inserted: 0, rows: [] });
  assert.deepEqual(await recordUsageLines({ db, clientId: CLIENT, lines: null }), { inserted: 0, rows: [] });
  assert.deepEqual(db.tables.usage_billing_ledger, []);
});

test('rows across several roles are all written', async () => {
  const db = makeDb({
    included: 0,
    roles: [
      { id: 'role_1', client_id: CLIENT, title: 'Hygienist' },
      { id: 'role_2', client_id: CLIENT, title: 'Front Desk' }
    ],
    interviews: [
      ...usedInterviews(2, { roleId: 'role_1', prefix: 'a' }),
      ...usedInterviews(3, { roleId: 'role_2', prefix: 'b' })
    ]
  });

  const usage = await compute(db);
  const written = await recordUsageLines({
    db, clientId: CLIENT, lines: usage.lines,
    stripeInvoiceId: 'in_1', periodStart: PERIOD_START, periodEnd: PERIOD_END
  });

  assert.equal(written.inserted, 5);
  assert.equal(usage.total_cents, 5 * 2500);
});

// --- the migration ---------------------------------------------------------

test('the ledger migration pins the invariants the service relies on', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260921140000_usage_billing_ledger.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.usage_billing_ledger/i);
  assert.match(sql, /interview_id uuid not null unique/i,
    'the unique interview is what actually prevents double billing');
  assert.match(sql, /unit_price_cents integer not null/i);
  assert.match(sql, /billed_at timestamptz null/i);
  assert.match(sql, /create index if not exists usage_billing_ledger_client_billed_at_idx[\s\S]*?\(client_id, billed_at\)/i);
  assert.match(sql, /create index if not exists usage_billing_ledger_stripe_invoice_id_idx[\s\S]*?\(stripe_invoice_id\)/i);
  assert.match(sql, /alter table public\.usage_billing_ledger enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.usage_billing_ledger\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.usage_billing_ledger\s*\n?to service_role/i);

  for (const grant of (sql.match(/grant[\s\S]*?;/gi) || [])) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i, `unexpected grant: ${grant}`);
  }
});

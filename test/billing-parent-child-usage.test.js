'use strict';

// Enterprise usage rolls up from child entities to the parent that pays.
//
// A child entity is a clients row with parent_client_id set. It owns roles,
// interviews and candidates, but it has no Stripe customer and no subscription,
// so it cannot be invoiced. Interviews run under a child's roles therefore have
// to appear on the parent's invoice, or they are never billed at all.
//
// Interview credits deliberately do NOT roll up — a credit is earned by a role
// and stays with the client that owns it. That asymmetry is asserted here too,
// so it reads as a decision rather than an oversight.
//
// Supabase is an in-memory stand-in; no database, no network.

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

const { computeUnbilledUsage, applyUsageToInvoice } = require(path.join(ROOT, 'src', 'services', 'usageBilling.js'));
const { listAvailableCredits } = require(path.join(ROOT, 'src', 'services', 'interviewCredits.js'));

const PARENT = 'client_parent';
const CHILD = 'client_child';
const PERIOD_END = '2026-09-01T00:00:00.000Z';

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`
};

function usedInterviews(count, { clientId, roleId, prefix }) {
  const start = new Date('2026-08-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: clientId,
    role_id: roleId,
    status: 'completed',
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

function makeDb({
  included = 0,
  unitPriceCents = 2500,
  childEntityLabel = 'Downtown Office',
  extraClients = [],
  roles = [
    { id: 'role_parent', client_id: PARENT, title: 'Hygienist' },
    { id: 'role_child', client_id: CHILD, title: 'Front Desk' }
  ],
  interviews = [],
  ledger = [],
  credits = []
} = {}) {
  return createFakeSupabase({
    clients: [
      { id: PARENT, parent_client_id: null, name: 'Acme Dental Group', stripe_customer_id: 'cus_1' },
      { id: CHILD, parent_client_id: PARENT, name: 'Acme Downtown', entity_label: childEntityLabel, stripe_customer_id: null },
      ...extraClients
    ],
    client_plan_settings: [{
      client_id: PARENT,
      plan_tier: 'enterprise',
      billing_model: 'usage',
      included_interviews_per_role: included,
      per_role_fee: 0,
      usage_interview_fee_cents: unitPriceCents,
      rollover_days: 90
    }],
    roles,
    interviews,
    usage_billing_ledger: ledger,
    interview_credits: credits,
    interview_credit_draws: []
  }, { unique: UNIQUE_KEYS });
}

const computeForParent = (db) => computeUnbilledUsage({ db, clientId: PARENT, periodEnd: PERIOD_END });

// --- the roll-up ----------------------------------------------------------

test('interviews under a child role are billed on the parent invoice', async () => {
  const db = makeDb({
    interviews: usedInterviews(3, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines.length, 1, 'the child role must produce a line');
  assert.equal(usage.lines[0].role_id, 'role_child');
  assert.equal(usage.lines[0].quantity, 3);
  assert.equal(usage.total_cents, 7500);
});

test('a child line carries the entity label so the invoice says which office', async () => {
  const db = makeDb({
    interviews: usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines[0].entity_label, 'Downtown Office');
});

test('the entity name stands in when a child has no label', async () => {
  const db = makeDb({
    childEntityLabel: null,
    interviews: usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines[0].entity_label, 'Acme Downtown');
});

test('the parent own roles carry no entity label', async () => {
  const db = makeDb({
    interviews: usedInterviews(2, { clientId: PARENT, roleId: 'role_parent', prefix: 'p' })
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines[0].role_id, 'role_parent');
  assert.equal(usage.lines[0].entity_label, null);
});

test('parent and child roles bill as separate lines on one invoice', async () => {
  const db = makeDb({
    interviews: [
      ...usedInterviews(2, { clientId: PARENT, roleId: 'role_parent', prefix: 'p' }),
      ...usedInterviews(3, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
    ]
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines.length, 2, 'one line per role, not one per client');
  assert.equal(usage.total_cents, 5 * 2500);
});

test('the included count is per role, so each entity role gets its own allowance', async () => {
  const db = makeDb({
    included: 2,
    interviews: [
      ...usedInterviews(5, { clientId: PARENT, roleId: 'role_parent', prefix: 'p' }),
      ...usedInterviews(4, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
    ]
  });

  const usage = await computeForParent(db);

  const byRole = Object.fromEntries(usage.lines.map((line) => [line.role_id, line.quantity]));
  assert.equal(byRole.role_parent, 3);
  assert.equal(byRole.role_child, 2);
});

test('an unrelated client entity is never swept in', async () => {
  const db = makeDb({
    extraClients: [{ id: 'client_other', parent_client_id: null, name: 'Other Dental' }],
    roles: [
      { id: 'role_child', client_id: CHILD, title: 'Front Desk' },
      { id: 'role_other', client_id: 'client_other', title: 'Theirs' }
    ],
    interviews: [
      ...usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' }),
      ...usedInterviews(9, { clientId: 'client_other', roleId: 'role_other', prefix: 'o' })
    ]
  });

  const usage = await computeForParent(db);

  assert.deepEqual(usage.lines.map((line) => line.role_id), ['role_child']);
  assert.equal(usage.total_cents, 5000);
});

test('a child entity of another parent is not billed to this one', async () => {
  const db = makeDb({
    extraClients: [
      { id: 'client_other', parent_client_id: null, name: 'Other Dental' },
      { id: 'other_child', parent_client_id: 'client_other', name: 'Other Branch' }
    ],
    roles: [{ id: 'role_other_child', client_id: 'other_child', title: 'Theirs' }],
    interviews: usedInterviews(4, { clientId: 'other_child', roleId: 'role_other_child', prefix: 'o' })
  });

  const usage = await computeForParent(db);

  assert.deepEqual(usage.lines, []);
});

test('a child interview is billed once, not again next cycle', async () => {
  const db = makeDb({
    interviews: usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' }),
    ledger: [{
      client_id: PARENT, role_id: 'role_child', interview_id: 'c_1',
      unit_price_cents: 2500, stripe_invoice_id: 'in_previous', billed_at: '2026-08-15T00:00:00.000Z'
    }]
  });

  const usage = await computeForParent(db);

  assert.equal(usage.lines[0].quantity, 1);
  assert.deepEqual(usage.lines[0].interview_ids, ['c_2']);
});

test('a parent with no children behaves exactly as before', async () => {
  const db = makeDb({
    extraClients: [],
    roles: [{ id: 'role_parent', client_id: PARENT, title: 'Hygienist' }],
    interviews: usedInterviews(3, { clientId: PARENT, roleId: 'role_parent', prefix: 'p' })
  });
  db.tables.clients = db.tables.clients.filter((client) => client.id === PARENT);

  const usage = await computeForParent(db);

  assert.equal(usage.lines.length, 1);
  assert.equal(usage.lines[0].entity_label, null);
  assert.equal(usage.total_cents, 7500);
});

// --- reaching Stripe ------------------------------------------------------

test('the invoice item names the entity and the ledger is written against the payer', async () => {
  const db = makeDb({
    interviews: usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' })
  });
  const items = [];
  const stripe = {
    invoiceItems: {
      create: async (payload) => {
        items.push(payload);
        return { id: `ii_${items.length}` };
      }
    }
  };

  const result = await applyUsageToInvoice({
    db, stripe, clientId: PARENT, customerId: 'cus_1', invoiceId: 'in_1',
    periodStart: '2026-08-01T00:00:00.000Z', periodEnd: PERIOD_END
  });

  assert.equal(result.applied, true);
  assert.equal(items.length, 1);
  assert.match(items[0].description, /^Interviews — Downtown Office · Front Desk \(/);
  assert.equal(items[0].metadata.role_id, 'role_child');
  assert.equal(items[0].metadata.client_id, PARENT, 'the line belongs to the payer');
  assert.equal(items[0].customer, 'cus_1');

  for (const row of db.tables.usage_billing_ledger) {
    assert.equal(row.client_id, PARENT, 'ledger rows are keyed to whoever pays');
    assert.equal(row.role_id, 'role_child');
    assert.ok(row.billed_at);
  }
});

test('a resumed invoice keeps the entity label on the rebuilt line', async () => {
  const db = makeDb({
    interviews: usedInterviews(2, { clientId: CHILD, roleId: 'role_child', prefix: 'c' }),
    ledger: [
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_1', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: null },
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_2', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: null }
    ]
  });
  const items = [];
  const stripe = {
    invoiceItems: {
      create: async (payload) => {
        items.push(payload);
        return { id: 'ii_1' };
      }
    }
  };

  await applyUsageToInvoice({
    db, stripe, clientId: PARENT, customerId: 'cus_1', invoiceId: 'in_1',
    periodStart: '2026-08-01T00:00:00.000Z', periodEnd: PERIOD_END
  });

  assert.equal(items.length, 1);
  assert.match(items[0].description, /Downtown Office · Front Desk/);
});

// --- overlapping runs -----------------------------------------------------

// Hides every ledger read from this caller while leaving the rows in the table,
// which is what a run that overlaps another one sees: the other run's rows are
// committed, but this run computed its usage before they landed. The reserving
// upsert still collides with them.
function withLedgerInvisibleToReads(db) {
  const inner = db.from.bind(db);
  return {
    tables: db.tables,
    calls: db.calls,
    from(table) {
      const query = inner(table);
      if (table !== 'usage_billing_ledger') return query;

      let isWrite = false;
      const realUpsert = query.upsert.bind(query);
      const realThen = query.then.bind(query);
      query.upsert = (payload, options) => {
        isWrite = true;
        return realUpsert(payload, options);
      };
      query.then = (resolve, reject) => {
        if (isWrite) return realThen(resolve, reject);
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return query;
    }
  };
}

test('a run that overlaps another bills nothing it did not reserve', async () => {
  // The other run already ledgered all three interviews.
  const db = makeDb({
    interviews: usedInterviews(3, { clientId: CHILD, roleId: 'role_child', prefix: 'c' }),
    ledger: [
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_1', unit_price_cents: 2500, stripe_invoice_id: 'in_other', billed_at: null },
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_2', unit_price_cents: 2500, stripe_invoice_id: 'in_other', billed_at: null },
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_3', unit_price_cents: 2500, stripe_invoice_id: 'in_other', billed_at: null }
    ]
  });
  const items = [];
  const stripe = {
    invoiceItems: {
      create: async (payload) => {
        items.push(payload);
        return { id: `ii_${items.length}` };
      }
    }
  };

  const result = await applyUsageToInvoice({
    db: withLedgerInvisibleToReads(db),
    stripe,
    clientId: PARENT,
    customerId: 'cus_1',
    invoiceId: 'in_mine',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: PERIOD_END
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'already_reserved');
  assert.deepEqual(items, [], 'the client must not be charged twice for the same interviews');
  assert.equal(db.tables.usage_billing_ledger.length, 3, 'and no second ledger row per interview');
});

test('an overlap that takes only some interviews bills only the rest', async () => {
  const db = makeDb({
    interviews: usedInterviews(3, { clientId: CHILD, roleId: 'role_child', prefix: 'c' }),
    ledger: [
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_1', unit_price_cents: 2500, stripe_invoice_id: 'in_other', billed_at: null },
      { client_id: PARENT, role_id: 'role_child', interview_id: 'c_2', unit_price_cents: 2500, stripe_invoice_id: 'in_other', billed_at: null }
    ]
  });
  const items = [];
  const stripe = {
    invoiceItems: {
      create: async (payload) => {
        items.push(payload);
        return { id: `ii_${items.length}` };
      }
    }
  };

  const result = await applyUsageToInvoice({
    db: withLedgerInvisibleToReads(db),
    stripe,
    clientId: PARENT,
    customerId: 'cus_1',
    invoiceId: 'in_mine',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: PERIOD_END
  });

  assert.equal(result.applied, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, 1, 'the two the other run took are not billed again');
  assert.equal(result.total_cents, 2500);
  assert.match(items[0].description, /Downtown Office · Front Desk/,
    'a line rebuilt from reserved rows keeps the entity label');
});

// --- the deliberate asymmetry ---------------------------------------------

test('credits do not roll up: a parent does not see a child credit', async () => {
  const db = makeDb({
    credits: [{
      id: 'credit_child', client_id: CHILD, source_role_id: 'role_child',
      quantity: 5, remaining: 5, minted_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2026-12-01T00:00:00.000Z', revoked_at: null
    }]
  });

  const parentCredits = await listAvailableCredits({ db, clientId: PARENT });
  const childCredits = await listAvailableCredits({ db, clientId: CHILD });

  assert.deepEqual(parentCredits, [], 'a credit stays with the client whose role earned it');
  assert.equal(childCredits.length, 1);
});

test('the asymmetry is written down where someone will find it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'services', 'usageBilling.js'), 'utf8');
  assert.match(source, /credits deliberately do not roll up/i,
    'the next reader must not think the credit behaviour is a bug');
});

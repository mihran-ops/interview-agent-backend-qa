'use strict';

// Interview credits: minting, revoking, listing and drawing.
//
// The rules being protected are the ones a client would notice if they broke:
// only Pro clients mint, a role mints once however many times it is closed,
// credit already spent by other roles is not clawed back from them, and an
// interview can never spend two credits.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const {
  drawCredit,
  listAvailableCredits,
  mintCreditForClosedRole,
  revokeCreditForReopenedRole,
  syncRoleCreditsForStatusChange
} = require(path.join(ROOT, 'src', 'services', 'interviewCredits.js'));

const CLIENT = 'client_1';
const NOW = '2026-09-21T12:00:00.000Z';

const UNIQUE_KEYS = {
  // Mirrors the partial unique index: one live credit per source role.
  interview_credits: (row) => (row.revoked_at == null ? `role:${row.source_role_id}` : null),
  interview_credit_draws: (row) => `interview:${row.interview_id}`
};

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  rolloverDays = 90,
  included = 30,
  purchases = [],
  interviews = [],
  credits = [],
  draws = [],
  roles = [{ id: 'role_1', client_id: CLIENT, rollover_drawn_offset: 0 }],
  ...rest
} = {}) {
  return createFakeSupabase({
    clients: [{ id: CLIENT, parent_client_id: null }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 699,
      usage_interview_fee_cents: null,
      rollover_days: rolloverDays
    }],
    role_interview_purchases: purchases,
    interviews,
    roles,
    interview_credits: credits,
    interview_credit_draws: draws
  }, { unique: UNIQUE_KEYS, ...rest });
}

const usedInterview = (id) => ({ id, client_id: CLIENT, role_id: 'role_1', status: 'completed' });

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: CLIENT,
  source_role_id: 'role_1',
  quantity: 5,
  remaining: 5,
  minted_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

// --- minting ---------------------------------------------------------------

test('closing a Pro role mints its unused allowance', async () => {
  const db = makeDb({ included: 30, interviews: [usedInterview('iv_1'), usedInterview('iv_2')] });

  const result = await mintCreditForClosedRole({
    db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW
  });

  assert.equal(result.minted, true);
  assert.equal(result.quantity, 28, '30 included, 2 used');
  assert.equal(db.tables.interview_credits.length, 1);
  assert.equal(db.tables.interview_credits[0].remaining, 28);
  assert.equal(db.tables.interview_credits[0].source_role_id, 'role_1');
});

test('paid top-ups count toward what rolls over', async () => {
  const db = makeDb({
    included: 30,
    purchases: [{ client_id: CLIENT, role_id: 'role_1', quantity: 10, status: 'paid' }],
    interviews: [usedInterview('iv_1')]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.quantity, 39, '30 included + 10 purchased - 1 used');
});

test('an unpaid top-up does not roll over', async () => {
  const db = makeDb({
    included: 30,
    purchases: [{ client_id: CLIENT, role_id: 'role_1', quantity: 10, status: 'pending' }]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.quantity, 30);
});

test('the credit expires rollover_days after the role closed, not after the mint ran', async () => {
  const db = makeDb({ rolloverDays: 90 });

  const result = await mintCreditForClosedRole({
    db, clientId: CLIENT, roleId: 'role_1',
    closedAt: '2026-09-21T12:00:00.000Z',
    now: '2026-09-25T00:00:00.000Z'
  });

  assert.equal(result.expires_at, '2026-12-20T12:00:00.000Z');
});

test('a client-specific rollover window is honoured', async () => {
  const db = makeDb({ rolloverDays: 30 });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.expires_at, '2026-10-21T12:00:00.000Z');
});

test('a fully used role mints nothing', async () => {
  const db = makeDb({
    included: 2,
    interviews: [usedInterview('iv_1'), usedInterview('iv_2')]
  });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'no_leftover' });
  assert.deepEqual(db.tables.interview_credits, []);
});

test('an Essentials role mints nothing — its allowance simply lapses', async () => {
  const db = makeDb({ planTier: 'basic', billingModel: 'fixed' });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'billing_model' });
  assert.deepEqual(db.tables.interview_credits, []);
});

test('an Enterprise role mints nothing — it is billed for usage instead', async () => {
  const db = makeDb({ planTier: 'enterprise', billingModel: 'usage' });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.deepEqual(result, { minted: false, reason: 'billing_model' });
});

test('a legacy Pro row with no billing model still mints', async () => {
  const db = makeDb({ planTier: 'pro', billingModel: null });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, true);
});

test('closing the same role twice mints once', async () => {
  const db = makeDb();

  const first = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });
  const second = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(first.minted, true);
  assert.equal(second.minted, false);
  assert.equal(second.reason, 'already_minted');
  assert.equal(second.credit.id, first.credit.id, 'the existing credit is returned, not a new one');
  assert.equal(db.tables.interview_credits.length, 1);
});

test('a revoked credit does not block a later mint for the same role', async () => {
  const db = makeDb({ credits: [credit({ revoked_at: '2026-09-10T00:00:00.000Z' })] });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, true, 'a reopened-then-reclosed role earns its allowance again');
  assert.equal(db.tables.interview_credits.length, 2);
});

test('a role whose availability cannot be read mints nothing', async () => {
  const db = makeDb({ failOn: { client_plan_settings: { op: 'select', error: { message: 'timeout' } } } });

  const result = await mintCreditForClosedRole({ db, clientId: CLIENT, roleId: 'role_1', closedAt: NOW, now: NOW });

  assert.equal(result.minted, false, 'a failed read must never be treated as a zero balance');
});

// --- revoking --------------------------------------------------------------

test('reopening a role revokes its credit', async () => {
  const db = makeDb({ credits: [credit()] });

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(result.revoked, true);
  assert.equal(result.drawn_count, 0);
  assert.equal(db.tables.interview_credits[0].revoked_at, NOW);
});

test('credit already spent elsewhere is charged back to the reopened role', async () => {
  const db = makeDb({ credits: [credit({ quantity: 5, remaining: 2 })] });

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(result.drawn_count, 3, '5 minted, 2 left, so 3 were spent');
  assert.equal(db.tables.roles[0].rollover_drawn_offset, 3,
    'the role gets its allowance back minus what other roles already used');
});

test('repeated close and reopen cycles accumulate the offset', async () => {
  const db = makeDb({
    credits: [credit({ quantity: 5, remaining: 3 })],
    roles: [{ id: 'role_1', client_id: CLIENT, rollover_drawn_offset: 4 }]
  });

  await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(db.tables.roles[0].rollover_drawn_offset, 6, '4 from an earlier cycle plus 2 from this one');
});

test('reopening a role that never minted is a no-op', async () => {
  const db = makeDb();

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.deepEqual(result, { revoked: false, reason: 'no_credit', drawn_count: 0 });
  assert.equal(db.tables.roles[0].rollover_drawn_offset, 0);
});

test('an already revoked credit is not revoked again', async () => {
  const db = makeDb({ credits: [credit({ revoked_at: '2026-09-10T00:00:00.000Z', quantity: 5, remaining: 1 })] });

  const result = await revokeCreditForReopenedRole({ db, roleId: 'role_1', now: NOW });

  assert.equal(result.revoked, false);
  assert.equal(db.tables.roles[0].rollover_drawn_offset, 0, 'the offset must not be charged twice');
});

// --- listing ---------------------------------------------------------------

test('available credits are the live ones, soonest to expire first', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_late', source_role_id: 'role_a', expires_at: '2026-12-01T00:00:00.000Z' }),
      credit({ id: 'c_soon', source_role_id: 'role_b', expires_at: '2026-10-01T00:00:00.000Z' }),
      credit({ id: 'c_expired', source_role_id: 'role_c', expires_at: '2026-09-01T00:00:00.000Z' }),
      credit({ id: 'c_revoked', source_role_id: 'role_d', revoked_at: NOW }),
      credit({ id: 'c_spent', source_role_id: 'role_e', remaining: 0 })
    ]
  });

  const available = await listAvailableCredits({ db, clientId: CLIENT, now: NOW });

  assert.deepEqual(available.map((c) => c.id), ['c_soon', 'c_late']);
});

test('the credits of another client are never listed', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_mine' }),
      credit({ id: 'c_theirs', client_id: 'client_2', source_role_id: 'role_x' })
    ]
  });

  const available = await listAvailableCredits({ db, clientId: CLIENT, now: NOW });

  assert.deepEqual(available.map((c) => c.id), ['c_mine']);
});

// --- drawing ---------------------------------------------------------------

test('a draw takes one unit from the earliest-expiring credit', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_late', source_role_id: 'role_a', remaining: 5, expires_at: '2026-12-01T00:00:00.000Z' }),
      credit({ id: 'c_soon', source_role_id: 'role_b', remaining: 5, expires_at: '2026-10-01T00:00:00.000Z' })
    ]
  });

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(result.drawn, true);
  assert.equal(result.credit_id, 'c_soon', 'spend what lapses first');
  assert.equal(db.tables.interview_credits.find((c) => c.id === 'c_soon').remaining, 4);
  assert.equal(db.tables.interview_credits.find((c) => c.id === 'c_late').remaining, 5);
  assert.equal(db.tables.interview_credit_draws.length, 1);
  assert.equal(db.tables.interview_credit_draws[0].interview_id, 'iv_1');
});

test('an exhausted credit is skipped for the next one', async () => {
  const db = makeDb({
    credits: [
      credit({ id: 'c_spent', source_role_id: 'role_a', remaining: 0, expires_at: '2026-10-01T00:00:00.000Z' }),
      credit({ id: 'c_live', source_role_id: 'role_b', remaining: 2, expires_at: '2026-11-01T00:00:00.000Z' })
    ]
  });

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(result.credit_id, 'c_live');
});

test('drawing twice for the same interview spends one unit', async () => {
  const db = makeDb({ credits: [credit({ remaining: 5 })] });

  const first = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });
  const second = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(first.drawn, true);
  assert.equal(second.drawn, false);
  assert.equal(second.reason, 'already_drawn');
  assert.equal(db.tables.interview_credits[0].remaining, 4, 'a late transcript must not draw again');
  assert.equal(db.tables.interview_credit_draws.length, 1);
});

test('a client with no credits draws nothing', async () => {
  const db = makeDb();

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.deepEqual(result, { drawn: false, reason: 'no_credits' });
  assert.deepEqual(db.tables.interview_credit_draws, []);
});

test('an expired credit cannot be drawn', async () => {
  const db = makeDb({ credits: [credit({ expires_at: '2026-09-01T00:00:00.000Z' })] });

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(result.drawn, false);
  assert.equal(result.reason, 'no_credits');
});

test('a credit taken by someone else between the read and the write is not over-spent', async () => {
  // Stages a concurrent draw on the first credit, so the conditional decrement
  // matches no row and the draw has to move on.
  let staged = false;
  const db = makeDb({
    credits: [
      credit({ id: 'c_soon', source_role_id: 'role_a', remaining: 1, expires_at: '2026-10-01T00:00:00.000Z' }),
      credit({ id: 'c_late', source_role_id: 'role_b', remaining: 4, expires_at: '2026-11-01T00:00:00.000Z' })
    ],
    beforeUpdate(table, patch, rows) {
      if (staged || table !== 'interview_credits' || !rows.length) return;
      if (rows[0].id !== 'c_soon') return;
      staged = true;
      rows[0].remaining = 0;
    }
  });

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(result.drawn, true);
  assert.equal(result.credit_id, 'c_late', 'the contended credit is left alone');
  assert.equal(db.tables.interview_credits.find((c) => c.id === 'c_soon').remaining, 0,
    'the concurrent draw keeps its unit');
  assert.equal(db.tables.interview_credits.find((c) => c.id === 'c_late').remaining, 3);
  assert.equal(db.tables.interview_credit_draws.length, 1, 'exactly one unit left the client');
});

test('a revoked credit cannot be drawn even if it is read first', async () => {
  const db = makeDb({ credits: [credit({ revoked_at: NOW })] });

  const result = await drawCredit({ db, clientId: CLIENT, roleId: 'role_2', interviewId: 'iv_1', now: NOW });

  assert.equal(result.drawn, false);
});

test('a draw needs a client, a role and an interview', async () => {
  const db = makeDb({ credits: [credit()] });

  for (const args of [
    { clientId: '', roleId: 'role_2', interviewId: 'iv_1' },
    { clientId: CLIENT, roleId: '', interviewId: 'iv_1' },
    { clientId: CLIENT, roleId: 'role_2', interviewId: '' }
  ]) {
    const result = await drawCredit({ db, ...args, now: NOW });
    assert.deepEqual(result, { drawn: false, reason: 'invalid_request' });
  }
  assert.deepEqual(db.tables.interview_credit_draws, []);
});

// --- the route hook --------------------------------------------------------

test('closing a role through the hook mints, reopening revokes', async () => {
  const db = makeDb({ included: 10, interviews: [usedInterview('iv_1')] });

  const closed = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'inactive', closedAt: NOW, now: NOW
  });
  assert.equal(closed.minted, true);
  assert.equal(closed.quantity, 9);

  const reopened = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'active', now: NOW
  });
  assert.equal(reopened.revoked, true);
  assert.equal(db.tables.interview_credits[0].revoked_at, NOW);
});

test('a credit failure is logged and never fails the status change', async () => {
  const db = makeDb({ failOn: { interview_credits: { op: 'select', error: { message: 'timeout' } } } });
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args);
  let result;
  try {
    result = await syncRoleCreditsForStatusChange({
      db, clientId: CLIENT, roleId: 'role_1', status: 'inactive', closedAt: NOW, now: NOW
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(result, { skipped: true, reason: 'error' }, 'closing a role must still succeed');
  const logged = lines.find(([message]) => message === 'interview_credit_sync_failed');
  assert.ok(logged, 'the failure must be visible');
  assert.equal(logged[1].role_id, 'role_1');
});

test('a status the hook does not act on is skipped', async () => {
  const db = makeDb();

  const result = await syncRoleCreditsForStatusChange({
    db, clientId: CLIENT, roleId: 'role_1', status: 'all', now: NOW
  });

  assert.deepEqual(result, { skipped: true, reason: 'status' });
});

test('both role-status routes run the credit hook after the status is written', () => {
  const fs = require('node:fs');
  const routes = [
    path.join(ROOT, 'src', 'routes', 'client', 'roles.js'),
    path.join(ROOT, 'src', 'routes', 'admin', 'roles.js')
  ];

  for (const routePath of routes) {
    const source = fs.readFileSync(routePath, 'utf8');
    assert.match(source, /require\('\.\.\/\.\.\/services\/interviewCredits'\)/,
      `${path.basename(path.dirname(routePath))}/roles.js must use the shared credit service`);
    assert.match(
      source,
      /role_status_update_failed[\s\S]*?not_found[\s\S]*?await syncRoleCreditsForStatusChange\(\{[\s\S]*?status,/,
      `${path.basename(path.dirname(routePath))}/roles.js must run the hook only after the update succeeded`
    );
  }
});

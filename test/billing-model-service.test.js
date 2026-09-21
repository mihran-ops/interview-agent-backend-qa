'use strict';

// resolveBillingModel: which model a client is charged under.
//
// The interesting cases are the legacy rows written before the billing_model
// column existed (null, so the plan tier decides), child clients (billed under
// the parent's settings), and the money unit — client_plan_settings holds
// dollars, the resolved value is cents.
//
// Supabase is stubbed; no database, no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const servicePath = path.join(ROOT, 'src', 'services', 'billingModel.js');

require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const {
  BILLING_MODELS,
  DEFAULT_ROLLOVER_DAYS,
  defaultBillingModelForPlanTier,
  normalizeBillingModel,
  resolveBillingModel
} = require(servicePath);

// Serves `clients` rows (for billing-owner resolution) and one plan-settings row.
// Records which client_id the plan settings were read for, so the parent/child
// behaviour can be asserted directly.
function makeDb({ clients = {}, planSettings = null, planSettingsError = null } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        maybeSingle() {
          if (table === 'clients') {
            return Promise.resolve({ data: clients[filters.id] || null, error: null });
          }
          if (table === 'client_plan_settings') {
            reads.push(filters.client_id);
            if (planSettingsError) return Promise.resolve({ data: null, error: planSettingsError });
            return Promise.resolve({ data: planSettings, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
      };
      return query;
    }
  };
}

const soloClient = { id: 'client_1', parent_client_id: null };

test('the three models are the only ones recognised', () => {
  assert.deepEqual(BILLING_MODELS, ['fixed', 'rollover', 'usage']);
});

test('a plan tier maps to its model, and anything unknown falls back to fixed', () => {
  assert.equal(defaultBillingModelForPlanTier('basic'), 'fixed');
  assert.equal(defaultBillingModelForPlanTier('essential'), 'fixed', 'essential is the display name for basic');
  assert.equal(defaultBillingModelForPlanTier('pro'), 'rollover');
  assert.equal(defaultBillingModelForPlanTier('enterprise'), 'usage');
  assert.equal(defaultBillingModelForPlanTier('PRO'), 'rollover');
  assert.equal(defaultBillingModelForPlanTier(''), 'fixed');
  assert.equal(defaultBillingModelForPlanTier(null), 'fixed');
  assert.equal(defaultBillingModelForPlanTier('legacy_tier'), 'fixed');
});

test('a stored model wins over the tier default, but only if it is a real model', () => {
  assert.equal(normalizeBillingModel('usage', 'basic'), 'usage');
  assert.equal(normalizeBillingModel('nonsense', 'pro'), 'rollover', 'garbage falls back to the tier');
  assert.equal(normalizeBillingModel(null, 'enterprise'), 'usage');
});

test('an Essentials client resolves to the fixed model', async () => {
  const db = makeDb({
    clients: { client_1: soloClient },
    planSettings: {
      plan_tier: 'basic', billing_model: 'fixed', included_interviews_per_role: 20,
      per_role_fee: 399, usage_interview_fee_cents: null, rollover_days: 90
    }
  });

  assert.deepEqual(await resolveBillingModel({ db, clientId: 'client_1' }), {
    billing_model: 'fixed',
    plan_tier: 'basic',
    included_interviews_per_role: 20,
    per_role_fee_cents: 39900,
    usage_interview_fee_cents: null,
    rollover_days: 90
  });
});

test('a Pro client resolves to rollover', async () => {
  const db = makeDb({
    clients: { client_1: soloClient },
    planSettings: {
      plan_tier: 'pro', billing_model: 'rollover', included_interviews_per_role: 30,
      per_role_fee: 699, usage_interview_fee_cents: null, rollover_days: 90
    }
  });

  const resolved = await resolveBillingModel({ db, clientId: 'client_1' });
  assert.equal(resolved.billing_model, 'rollover');
  assert.equal(resolved.per_role_fee_cents, 69900);
  assert.equal(resolved.rollover_days, 90);
});

test('an Enterprise client resolves to usage and keeps its per-interview price', async () => {
  const db = makeDb({
    clients: { client_1: soloClient },
    planSettings: {
      plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0,
      per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90
    }
  });

  const resolved = await resolveBillingModel({ db, clientId: 'client_1' });
  assert.equal(resolved.billing_model, 'usage');
  assert.equal(resolved.usage_interview_fee_cents, 2500);
  assert.equal(resolved.included_interviews_per_role, 0, 'zero included is a real Enterprise setting');
  assert.equal(resolved.per_role_fee_cents, 0);
});

test('a legacy row with no billing_model falls back to the tier', async () => {
  for (const [planTier, expected] of [['basic', 'fixed'], ['pro', 'rollover'], ['enterprise', 'usage']]) {
    const db = makeDb({
      clients: { client_1: soloClient },
      planSettings: {
        plan_tier: planTier, billing_model: null, included_interviews_per_role: 20,
        per_role_fee: 399, usage_interview_fee_cents: null, rollover_days: null
      }
    });

    const resolved = await resolveBillingModel({ db, clientId: 'client_1' });
    assert.equal(resolved.billing_model, expected, `${planTier} should fall back to ${expected}`);
    assert.equal(resolved.rollover_days, DEFAULT_ROLLOVER_DAYS, 'a null rollover window uses the default');
  }
});

test('a child client is billed under its parent plan settings', async () => {
  const db = makeDb({
    clients: {
      child_1: { id: 'child_1', parent_client_id: 'parent_1' },
      parent_1: { id: 'parent_1', parent_client_id: null }
    },
    planSettings: {
      plan_tier: 'pro', billing_model: 'rollover', included_interviews_per_role: 30,
      per_role_fee: 699, usage_interview_fee_cents: null, rollover_days: 45
    }
  });

  const resolved = await resolveBillingModel({ db, clientId: 'child_1' });
  assert.equal(resolved.billing_model, 'rollover');
  assert.equal(resolved.rollover_days, 45);
  assert.deepEqual(db.reads, ['parent_1'], 'plan settings must be read for the billing owner');
});

test('a missing plan settings row resolves to nulls rather than a guessed model', async () => {
  const db = makeDb({ clients: { client_1: soloClient }, planSettings: null });

  assert.deepEqual(await resolveBillingModel({ db, clientId: 'client_1' }), {
    billing_model: null,
    plan_tier: null,
    included_interviews_per_role: null,
    per_role_fee_cents: null,
    usage_interview_fee_cents: null,
    rollover_days: null
  });
});

test('a lookup failure resolves to nulls and never throws', async () => {
  const db = makeDb({
    clients: { client_1: soloClient },
    planSettingsError: { message: 'connection reset' }
  });

  const resolved = await resolveBillingModel({ db, clientId: 'client_1' });
  assert.equal(resolved.billing_model, null);
  assert.equal(resolved.rollover_days, null);
});

test('missing arguments resolve to nulls without touching the database', async () => {
  const db = makeDb({ clients: { client_1: soloClient } });
  assert.equal((await resolveBillingModel({ db, clientId: '' })).billing_model, null);
  assert.equal((await resolveBillingModel({ db: null, clientId: 'client_1' })).billing_model, null);
  assert.deepEqual(db.reads, []);
});

test('an unresolvable billing owner resolves to nulls', async () => {
  const db = makeDb({ clients: {} });

  assert.equal((await resolveBillingModel({ db, clientId: 'client_missing' })).billing_model, null);
  assert.deepEqual(db.reads, [], 'plan settings must not be read without a billing owner');
});

test('a negative or fractional rollover window falls back to the default', async () => {
  for (const stored of [0, -5, 'abc']) {
    const db = makeDb({
      clients: { client_1: soloClient },
      planSettings: {
        plan_tier: 'pro', billing_model: 'rollover', included_interviews_per_role: 30,
        per_role_fee: 699, usage_interview_fee_cents: null, rollover_days: stored
      }
    });
    assert.equal(
      (await resolveBillingModel({ db, clientId: 'client_1' })).rollover_days,
      DEFAULT_ROLLOVER_DAYS,
      `rollover_days ${JSON.stringify(stored)} is not a usable window`
    );
  }
});

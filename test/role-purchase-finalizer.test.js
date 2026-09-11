'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  finalizePendingRolePurchase,
  finalizePrepaidRoleCredit,
  findUnusedFirstRolePrepayCredit,
} = require('../src/services/rolePurchaseFinalizer');

const migrationsDir = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations'
);
const claimCreditMigrationPath = path.join(migrationsDir, '20260627130000_first_role_prepay_claim_credit_only.sql');

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    if (filter.type === 'is') {
      const value = row?.[filter.column];
      return filter.value === null ? value === null || value === undefined : value === filter.value;
    }
    return String(row?.[filter.column] ?? '') === String(filter.value ?? '');
  });
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.insertPayload = null;
    this.updatePayload = null;
    this.limitCount = null;
  }

  select() { return this; }
  order() { return this; }

  limit(count) {
    this.limitCount = Number(count || 0);
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ type: 'is', column, value });
    return this;
  }

  in(column, values) {
    this.inFilters.push({ column, values: new Set((values || []).map(String)) });
    return this;
  }

  insert(payload) {
    this.insertPayload = { ...(payload || {}) };
    return this;
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) };
    return this;
  }

  rows() {
    if (this.table === 'roles') return this.db.roles;
    if (this.table === 'pending_role_purchases') return this.db.pendingRolePurchases;
    if (this.table === 'client_role_credits') return this.db.clientRoleCredits;
    return [];
  }

  filteredRows() {
    let rows = this.rows().filter((row) => matchesFilters(row, this.filters));
    for (const filter of this.inFilters) {
      rows = rows.filter((row) => filter.values.has(String(row?.[filter.column] ?? '')));
    }
    if (this.limitCount) rows = rows.slice(0, this.limitCount);
    return rows;
  }

  async maybeSingle() {
    if (this.updatePayload) {
      const result = await this.execute();
      return {
        data: Array.isArray(result.data) ? (result.data[0] || null) : (result.data || null),
        error: result.error || null,
      };
    }
    return { data: this.filteredRows()[0] || null, error: null };
  }

  async single() {
    if (this.insertPayload) {
      if (this.table === 'roles' && this.db.roleInsertError) {
        return { data: null, error: { message: this.db.roleInsertError } };
      }
      const row = { ...this.insertPayload };
      if (this.table === 'roles' && !row.id) row.id = `role-${this.db.roles.length + 1}`;
      this.rows().push(row);
      this.db.writes.push({ table: this.table, type: 'insert', row });
      return { data: row, error: null };
    }
    return this.maybeSingle();
  }

  async execute() {
    if (this.insertPayload) return this.single();
    if (this.updatePayload) {
      const rows = this.filteredRows();
      for (const row of rows) Object.assign(row, this.updatePayload);
      this.db.writes.push({ table: this.table, type: 'update', rows, payload: this.updatePayload });
      return { data: rows, error: null };
    }
    return { data: this.filteredRows(), error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function makeDb(overrides = {}) {
  const db = {
    roles: overrides.roles ? [...overrides.roles] : [],
    pendingRolePurchases: overrides.pendingRolePurchases ? [...overrides.pendingRolePurchases] : [],
    clientRoleCredits: overrides.clientRoleCredits ? [...overrides.clientRoleCredits] : [],
    roleInsertError: overrides.roleInsertError || null,
    writes: [],
    rpcCalls: [],
    from(table) {
      return new FakeQuery(this, table);
    },
    async rpc(name, args) {
      this.rpcCalls.push({ name, args });
      if (overrides.rpcError) return { data: null, error: overrides.rpcError };
      if (overrides.rpcResponse) return { data: overrides.rpcResponse, error: null };
      if (name !== 'claim_first_role_prepay_credit') return { data: null, error: { message: 'unknown_rpc' } };
      const credit = this.clientRoleCredits.find((row) => {
        return row.billing_client_id === args.p_billing_client_id &&
          row.credit_type === 'first_role_prepay' &&
          row.status === 'unused' &&
          !row.used_at &&
          !row.used_by_role_id;
      });
      if (!credit) {
        return { data: [{ ok: false, credit_id: null, status: 'credit_not_available' }], error: null };
      }
      credit.status = 'claimed';
      credit.source_client_id = credit.source_client_id || args.p_source_client_id;
      credit.metadata = {
        ...(credit.metadata || {}),
        claimed_by: args.p_claim_context,
        claimed_client_id: args.p_source_client_id,
        claimed_at: '2026-06-26T12:00:00.000Z',
      };
      this.writes.push({ table: 'client_role_credits', type: 'rpc_claim', row: credit });
      return { data: [{ ok: true, credit_id: credit.id, status: 'claimed' }], error: null };
    },
  };
  return db;
}

test('finalizePendingRolePurchase creates role, updates JD, generates rubric, and finalizes pending row', async () => {
  const db = makeDb({
    pendingRolePurchases: [{
      id: 'pending-1',
      client_id: 'client-1',
      role_title: 'Dental Hygienist',
      interview_type: 'DETAILED',
      jd_storage_path: 'job-descriptions/pending/client-1/pending-1/jd.pdf',
      status: 'finalizing',
      finalized_role_id: null,
    }],
  });
  const generated = [];

  const result = await finalizePendingRolePurchase({
    db,
    pendingRolePurchase: db.pendingRolePurchases[0],
    generateRubricAndKBForRole: async (roleId) => generated.push(roleId),
  });

  assert.equal(result.role.id, 'role-1');
  assert.equal(db.roles[0].client_id, 'client-1');
  assert.equal(db.roles[0].title, 'Dental Hygienist');
  assert.equal(db.roles[0].interview_type, 'leadership');
  assert.equal(db.roles[0].pending_role_purchase_id, 'pending-1');
  assert.equal(db.roles[0].job_description_url, 'job-descriptions/pending/client-1/pending-1/jd.pdf');
  assert.deepEqual(generated, ['role-1']);
  assert.equal(db.pendingRolePurchases[0].status, 'finalized');
  assert.equal(db.pendingRolePurchases[0].finalized_role_id, 'role-1');
})

function hotfixCreditMigrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((filename) => {
      return filename.startsWith('20260627') &&
        (filename.includes('_first_role') || filename.includes('_consume'));
    })
    .map((filename) => path.join(migrationsDir, filename));
}

test('claim first-role credit RPC qualifies credit columns and claims only', () => {
  const sql = fs.readFileSync(claimCreditMigrationPath, 'utf8');

  assert.match(sql, /create or replace function public\.claim_first_role_prepay_credit/i);
  assert.match(sql, /from public\.client_role_credits as crc/i);
  assert.match(sql, /where crc\.billing_client_id = p_billing_client_id/i);
  assert.match(sql, /and crc\.credit_type = 'first_role_prepay'/i);
  assert.match(sql, /and crc\.status = 'unused'/i);
  assert.match(sql, /order by crc\.created_at asc, crc\.id asc/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /set status = 'claimed'/i);
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\.roles/i);
  assert.doesNotMatch(sql, /gen_random_bytes|gen_random_uuid|uuid_generate_v4/i);
})

test('FR-3 hotfix credit migrations avoid SQL role inserts and UUID helpers', () => {
  for (const filename of hotfixCreditMigrationFiles()) {
    const sql = fs.readFileSync(filename, 'utf8');

    assert.doesNotMatch(sql, /gen_random_bytes|gen_random_uuid|uuid_generate_v4/i);
    assert.doesNotMatch(sql, /\binsert\s+into\s+public\.roles/i);
  }
})

test('findUnusedFirstRolePrepayCredit reads by billing client and unused first-role state', async () => {
  const db = makeDb({
    clientRoleCredits: [
      { id: 'used-credit', billing_client_id: 'billing-1', credit_type: 'first_role_prepay', status: 'used', used_at: '2026-06-25T00:00:00Z', used_by_role_id: 'role-used' },
      { id: 'unused-credit', billing_client_id: 'billing-1', credit_type: 'first_role_prepay', status: 'unused', used_at: null, used_by_role_id: null },
    ],
  });

  const credit = await findUnusedFirstRolePrepayCredit({ db, billingClientId: 'billing-1' });
  assert.equal(credit.id, 'unused-credit');
})

test('finalizePrepaidRoleCredit consumes credit through RPC and enriches created role', async () => {
  const db = makeDb({
    clientRoleCredits: [{
      id: 'credit-1',
      billing_client_id: 'billing-1',
      source_client_id: 'billing-1',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null,
    }],
  });
  const generated = [];

  const result = await finalizePrepaidRoleCredit({
    db,
    billingClientId: 'billing-1',
    clientId: 'child-1',
    roleTitle: 'Front Desk',
    interviewType: 'BASIC',
    jdStoragePath: 'job-descriptions/pending/child-1/credit/jd.pdf',
    generateRubricAndKBForRole: async (roleId) => generated.push(roleId),
  });

  assert.equal(result.applied, true);
  assert.match(result.role_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.credit_id, 'credit-1');
  assert.equal(result.enrichment_status, 'completed');
  assert.equal(db.rpcCalls[0].name, 'claim_first_role_prepay_credit');
  assert.equal(db.rpcCalls[0].args.p_billing_client_id, 'billing-1');
  assert.equal(db.rpcCalls[0].args.p_source_client_id, 'child-1');
  assert.equal(db.rpcCalls[0].args.p_claim_context, 'role_checkout');
  assert.equal(db.roles[0].client_id, 'child-1');
  assert.equal(db.clientRoleCredits[0].status, 'used');
  assert.equal(db.clientRoleCredits[0].used_by_role_id, result.role_id);
  assert.equal(db.clientRoleCredits[0].metadata.claimed_by, 'role_checkout');
  assert.equal(db.clientRoleCredits[0].metadata.consumed_by, 'role_checkout');
  assert.deepEqual(generated, [result.role_id]);
})

test('finalizePrepaidRoleCredit returns not applied when RPC loses credit race', async () => {
  const db = makeDb();
  let generated = false;

  const result = await finalizePrepaidRoleCredit({
    db,
    billingClientId: 'billing-1',
    clientId: 'child-1',
    roleTitle: 'Front Desk',
    interviewType: 'BASIC',
    jdStoragePath: 'job-descriptions/pending/child-1/credit/jd.pdf',
    generateRubricAndKBForRole: async () => { generated = true; },
  });

  assert.equal(result.applied, false);
  assert.equal(result.status, 'credit_not_available');
  assert.equal(db.roles.length, 0);
  assert.equal(generated, false);
})

test('finalizePrepaidRoleCredit releases claimed credit when role creation fails', async () => {
  const db = makeDb({
    roleInsertError: 'roles insert failed',
    clientRoleCredits: [{
      id: 'credit-1',
      billing_client_id: 'billing-1',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null,
      metadata: {},
    }],
  });

  await assert.rejects(
    finalizePrepaidRoleCredit({
      db,
      billingClientId: 'billing-1',
      clientId: 'billing-1',
      roleTitle: 'Office Manager',
      interviewType: 'BASIC',
      jdStoragePath: 'job-descriptions/pending/billing-1/credit/jd.pdf',
    }),
    /roles insert failed/
  );

  assert.equal(db.roles.length, 0);
  assert.equal(db.clientRoleCredits[0].status, 'unused');
  assert.equal(db.clientRoleCredits[0].used_at, null);
  assert.equal(db.clientRoleCredits[0].used_by_role_id, null);
  assert.equal(db.clientRoleCredits[0].metadata.claimed_by, 'role_checkout');
  assert.equal(db.clientRoleCredits[0].metadata.released_by, 'role_checkout');
  assert.equal(db.clientRoleCredits[0].metadata.release_reason, 'roles insert failed');
})

test('finalizePrepaidRoleCredit can return applied even if enrichment fails after atomic consumption', async () => {
  const logs = [];
  const db = makeDb({
    clientRoleCredits: [{
      id: 'credit-1',
      billing_client_id: 'billing-1',
      credit_type: 'first_role_prepay',
      status: 'unused',
    }],
  });

  const result = await finalizePrepaidRoleCredit({
    db,
    billingClientId: 'billing-1',
    clientId: 'billing-1',
    roleTitle: 'Office Manager',
    interviewType: 'TECHNICAL',
    jdStoragePath: 'job-descriptions/pending/billing-1/credit/jd.pdf',
    generateRubricAndKBForRole: async () => { throw new Error('rubric unavailable'); },
    throwOnEnrichmentError: false,
    logger: { error: (...args) => logs.push(args) },
  });

  assert.equal(result.applied, true);
  assert.equal(result.enrichment_status, 'failed');
  assert.equal(db.clientRoleCredits[0].status, 'used');
  assert.equal(db.clientRoleCredits[0].used_by_role_id, result.role_id);
  assert.match(JSON.stringify(logs), /prepaid_role_enrichment_failed/);
})

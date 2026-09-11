'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  ROLE_ACTIVITY_CHECKS,
  findRoleActivity,
  getRoleJdReplacementEligibility,
} = require('../src/lib/roleJdReplacement');

const ROLE_A = '11111111-1111-4111-8111-111111111111';
const ROLE_B = '22222222-2222-4222-8222-222222222222';

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.db.queries.push(this);
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ kind: 'in', column, values: new Set(values) });
    return this;
  }

  is(column, value) {
    this.filters.push({ kind: 'is', column, value });
    return this;
  }

  async execute() {
    const error = this.db.errors[this.table] || null;
    if (error) return { data: null, error };
    const data = (this.db.activity[this.table] || []).filter((row) => this.filters.every((filter) => {
      if (filter.kind === 'eq') return row?.[filter.column] === filter.value;
      if (filter.kind === 'in') return filter.values.has(row?.[filter.column]);
      return filter.value === null ? row?.[filter.column] == null : row?.[filter.column] === filter.value;
    }));
    return { data, error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function makeDb({ activity = {}, errors = {} } = {}) {
  return {
    activity,
    errors,
    queries: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

test('replacement eligibility is true for active roles without activity', async () => {
  const db = makeDb();
  const result = await getRoleJdReplacementEligibility({
    db,
    roles: [{ id: ROLE_A, status: 'active' }],
  });

  assert.deepEqual(result[ROLE_A], { eligible: true, blockers: [] });
  assert.equal(db.queries.length, ROLE_ACTIVITY_CHECKS.length);
});

test('replacement eligibility returns each shared blocker category', async (t) => {
  for (const check of ROLE_ACTIVITY_CHECKS) {
    await t.test(check.label, async () => {
      const row = { role_id: ROLE_A };
      if (check.activeOnly) row.archived_at = null;
      const db = makeDb({ activity: { [check.table]: [row] } });
      const result = await getRoleJdReplacementEligibility({
        db,
        roles: [{ id: ROLE_A, status: 'active' }],
      });

      assert.deepEqual(result[ROLE_A], { eligible: false, blockers: [check.label] });
    });
  }
});

test('archived automation rules do not block replacement eligibility', async () => {
  const db = makeDb({
    activity: {
      automation_rules: [{ role_id: ROLE_A, archived_at: '2026-07-01T00:00:00Z' }],
    },
  });
  const result = await getRoleJdReplacementEligibility({
    db,
    roles: [{ id: ROLE_A, status: 'active' }],
  });

  assert.deepEqual(result[ROLE_A], { eligible: true, blockers: [] });
});

test('batched eligibility uses one query per blocker table for multiple roles', async () => {
  const db = makeDb({
    activity: {
      candidates: [{ role_id: ROLE_A }],
      otp_tokens: [{ role_id: ROLE_B }],
    },
  });
  const result = await getRoleJdReplacementEligibility({
    db,
    roles: [
      { id: ROLE_A, status: 'active' },
      { id: ROLE_B, status: 'active' },
    ],
  });

  assert.deepEqual(result[ROLE_A], { eligible: false, blockers: ['candidates'] });
  assert.deepEqual(result[ROLE_B], { eligible: false, blockers: ['otp_tokens'] });
  assert.equal(db.queries.length, ROLE_ACTIVITY_CHECKS.length);
  assert.ok(db.queries.every((query) => query.filters.some((filter) => filter.kind === 'in')));
});

test('inactive roles are ineligible before activity checks can permit replacement', async () => {
  const result = await getRoleJdReplacementEligibility({
    db: makeDb(),
    roles: [{ id: ROLE_A, status: 'inactive' }],
  });
  assert.deepEqual(result[ROLE_A], { eligible: false, blockers: ['role_not_active'] });
});

test('endpoint activity lookup delegates to the shared eligibility helper', async () => {
  const db = makeDb({ activity: { otp_tokens: [{ role_id: ROLE_A }] } });
  assert.deepEqual(await findRoleActivity(db, ROLE_A), ['otp_tokens']);
});

test('client and admin role list sources expose the eligibility summary', () => {
  const root = path.join(__dirname, '..');
  const clientListSource = fs.readFileSync(path.join(root, 'routes', 'roles.js'), 'utf8');
  const adminListSource = fs.readFileSync(path.join(root, 'src', 'routes', 'admin', 'roles.js'), 'utf8');
  const replacementServiceSource = fs.readFileSync(path.join(root, 'src', 'lib', 'roleJdReplacement.js'), 'utf8');

  assert.match(clientListSource, /getRoleJdReplacementEligibility/);
  assert.match(clientListSource, /job_description_replacement/);
  assert.match(adminListSource, /getRoleJdReplacementEligibility/);
  assert.match(adminListSource, /job_description_replacement/);
  assert.match(replacementServiceSource, /getRoleJdReplacementEligibility\(\{ db, roles: \[role\] \}\)/);
});

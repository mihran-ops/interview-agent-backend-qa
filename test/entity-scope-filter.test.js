'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  resolveEntityFilter,
  withEntityFields,
} = require('../src/services/entityScopeFilter');

const CLIENTS = [
  { id: 'parent-1', name: 'Acme Dental', parent_client_id: null, entity_label: 'office' },
  { id: 'child-1', name: 'Castle Rock Office', parent_client_id: 'parent-1', entity_label: 'office' },
  { id: 'child-2', name: 'Denver Office', parent_client_id: 'parent-1', entity_label: 'office' },
  { id: 'child-archived', name: 'Archived Office', parent_client_id: 'parent-1', entity_label: 'office', archived_at: '2026-06-18T12:00:00.000Z' },
  { id: 'parent-2', name: 'Other Parent', parent_client_id: null, entity_label: 'location' },
  { id: 'child-3', name: 'Other Child', parent_client_id: 'parent-2', entity_label: 'location' },
];

class FakeQuery {
  constructor(rows) {
    this.rows = rows;
    this.filters = [];
    this.single = false;
  }

  select() {
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  in(column, values) {
    const allowed = new Set((values || []).map((value) => String(value)));
    this.filters.push({ column, allowed });
    return this;
  }

  is(column, value) {
    this.filters.push({ column, isValue: value });
    return this;
  }

  order() {
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  execute() {
    let data = this.rows.slice();
    for (const filter of this.filters) {
      if (filter.allowed) {
        data = data.filter((row) => filter.allowed.has(String(row[filter.column] || '')));
      } else if (Object.prototype.hasOwnProperty.call(filter, 'isValue')) {
        data = data.filter((row) => {
          if (filter.isValue === null) return row[filter.column] === null || row[filter.column] === undefined;
          return row[filter.column] === filter.isValue;
        });
      } else {
        data = data.filter((row) => String(row[filter.column] || '') === filter.value);
      }
    }
    if (this.single) return { data: data[0] || null, error: null };
    return { data, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function makeDb(clients = CLIENTS) {
  return {
    from(table) {
      assert.equal(table, 'clients');
      return new FakeQuery(clients);
    },
  };
}

function makeReq(ids, isAdmin = false) {
  return {
    isGlobalAdmin: isAdmin,
    isAdmin,
    clientScope: {
      accessibleClientIds: ids,
      effectiveClientIds: ids,
    },
  };
}

test('entity filter parent returns direct parent only from a child selection', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['parent-1', 'child-1', 'child-2']),
    clientId: 'child-1',
    entityFilter: 'parent',
    requestId: 'req-1',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.clientIds, ['parent-1']);
  assert.equal(result.entitiesById['parent-1'].name, 'Acme Dental');
});

test('entity filter all omits archived child entities from active hierarchy options', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['parent-1', 'child-1', 'child-2', 'child-archived']),
    clientId: 'parent-1',
    entityFilter: 'all',
    requestId: 'req-archived-all',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.clientIds, ['parent-1', 'child-1', 'child-2']);
  assert.equal(result.entitiesById['child-archived'], undefined);
});

test('entity filter rejects a specific archived child entity as inactive scope', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['parent-1', 'child-1', 'child-2', 'child-archived']),
    clientId: 'parent-1',
    entityFilter: 'child-archived',
    requestId: 'req-archived-specific',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ENTITY_SCOPE_MISMATCH');
});

test('entity filter all returns parent and child ids in the selected hierarchy', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['parent-1', 'child-1', 'child-2']),
    clientId: 'parent-1',
    entityFilter: 'all',
    requestId: 'req-2',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.clientIds, ['parent-1', 'child-1', 'child-2']);
});

test('entity filter specific child rejects ids outside the selected hierarchy', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['parent-1', 'child-1', 'child-2']),
    clientId: 'parent-1',
    entityFilter: 'child-3',
    requestId: 'req-3',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ENTITY_SCOPE_MISMATCH');
});

test('entity filter parent rejects inaccessible parent scope for non-admins', async () => {
  const result = await resolveEntityFilter({
    db: makeDb(),
    req: makeReq(['child-1']),
    clientId: 'child-1',
    entityFilter: 'parent',
    requestId: 'req-4',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CLIENT_SCOPE_MISMATCH');
});

test('withEntityFields displays the actual parent client name, not the word Parent', () => {
  const row = withEntityFields(
    { id: 'role-1', client_id: 'parent-1' },
    { 'parent-1': { id: 'parent-1', name: 'Acme Dental', is_parent_client: true } },
    'parent-1'
  );

  assert.equal(row.entity_id, 'parent-1');
  assert.equal(row.entity_name, 'Acme Dental');
});

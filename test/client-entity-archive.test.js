'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  archiveChildClientEntity,
  restoreChildClientEntity,
} = require('../src/services/clientEntityArchive');

const BASE_TABLES = {
  clients: [
    { id: 'parent-1', name: 'Acme Dental', parent_client_id: null, entity_label: 'office', archived_at: null },
    { id: 'child-1', name: 'Castle Rock Office', parent_client_id: 'parent-1', entity_label: 'office', archived_at: null },
    {
      id: 'child-archived',
      name: 'Archived Office',
      parent_client_id: 'parent-1',
      entity_label: 'office',
      archived_at: '2026-06-18T12:00:00.000Z',
      archived_reason: 'Closed',
      archived_by_user_id: 'user-admin',
    },
    { id: 'parent-2', name: 'Other Parent', parent_client_id: null, entity_label: 'location', archived_at: null },
    { id: 'child-3', name: 'Other Child', parent_client_id: 'parent-2', entity_label: 'location', archived_at: null },
  ],
  roles: [{ id: 'role-1', client_id: 'child-1', title: 'Dental Assistant' }],
  candidates: [{ id: 'candidate-1', client_id: 'child-1', name: 'Candidate One' }],
  client_members: [{ client_id: 'child-1', user_id: 'user-1', role: 'manager' }],
};

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.rows = db.tables[table] || [];
    this.filters = [];
    this.updatePayload = null;
    this.expectSingle = false;
    this.expectMaybeSingle = false;
  }

  select() {
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) };
    this.db.updates.push({ table: this.table, payload: this.updatePayload });
    return this;
  }

  single() {
    this.expectSingle = true;
    return this;
  }

  maybeSingle() {
    this.expectMaybeSingle = true;
    return this;
  }

  filteredRows() {
    let data = this.rows.slice();
    for (const filter of this.filters) {
      data = data.filter((row) => String(row[filter.column] || '') === filter.value);
    }
    return data;
  }

  execute() {
    if (this.updatePayload) {
      const matches = this.filteredRows();
      for (const row of matches) Object.assign(row, this.updatePayload);
      return { data: matches[0] || null, error: null };
    }
    const data = this.filteredRows();
    if (this.expectSingle || this.expectMaybeSingle) return { data: data[0] || null, error: null };
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

function cloneTables() {
  return JSON.parse(JSON.stringify(BASE_TABLES));
}

function makeDb(tables = cloneTables()) {
  return {
    tables,
    updates: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

test('archiveChildClientEntity rejects parent clients through the child archive path', async () => {
  const db = makeDb();
  const result = await archiveChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'parent-1',
    requestId: 'req-parent',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'child_entity_required');
  assert.deepEqual(db.updates, []);
});

test('archiveChildClientEntity rejects child entities outside the selected parent', async () => {
  const db = makeDb();
  const result = await archiveChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'child-3',
    requestId: 'req-scope',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'client_entity_not_found');
  assert.deepEqual(db.updates, []);
});

test('archiveChildClientEntity sets archive fields without touching associated records', async () => {
  const tables = cloneTables();
  const beforeRoles = JSON.stringify(tables.roles);
  const beforeCandidates = JSON.stringify(tables.candidates);
  const beforeMembers = JSON.stringify(tables.client_members);
  const db = makeDb(tables);

  const result = await archiveChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'child-1',
    actorUserId: 'user-admin',
    reason: 'No longer active',
    archivedAt: '2026-06-18T12:00:00.000Z',
    requestId: 'req-archive',
  });

  assert.equal(result.ok, true);
  assert.equal(result.entity.id, 'child-1');
  assert.equal(result.entity.archived_at, '2026-06-18T12:00:00.000Z');
  assert.equal(result.entity.archived_by_user_id, 'user-admin');
  assert.equal(result.entity.archived_reason, 'No longer active');
  assert.deepEqual(db.updates.map((entry) => entry.table), ['clients']);
  assert.equal(JSON.stringify(tables.roles), beforeRoles);
  assert.equal(JSON.stringify(tables.candidates), beforeCandidates);
  assert.equal(JSON.stringify(tables.client_members), beforeMembers);
});

test('restoreChildClientEntity rejects parent clients through the child restore path', async () => {
  const db = makeDb();
  const result = await restoreChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'parent-1',
    requestId: 'req-restore-parent',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'child_entity_required');
  assert.deepEqual(db.updates, []);
});

test('restoreChildClientEntity rejects child entities outside the selected parent', async () => {
  const db = makeDb();
  const result = await restoreChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'child-3',
    requestId: 'req-restore-scope',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'client_entity_not_found');
  assert.deepEqual(db.updates, []);
});

test('restoreChildClientEntity clears archive fields without touching associated records', async () => {
  const tables = cloneTables();
  tables.roles.push({ id: 'role-archived', client_id: 'child-archived', title: 'Assistant' });
  tables.candidates.push({ id: 'candidate-archived', client_id: 'child-archived', name: 'Candidate Archived' });
  tables.client_members.push({ client_id: 'child-archived', user_id: 'user-archived', role: 'manager' });
  const beforeRoles = JSON.stringify(tables.roles);
  const beforeCandidates = JSON.stringify(tables.candidates);
  const beforeMembers = JSON.stringify(tables.client_members);
  const db = makeDb(tables);

  const result = await restoreChildClientEntity({
    db,
    parentClientId: 'parent-1',
    entityClientId: 'child-archived',
    requestId: 'req-restore',
  });

  assert.equal(result.ok, true);
  assert.equal(result.entity.id, 'child-archived');
  assert.equal(result.entity.archived_at, null);
  assert.equal(result.entity.archived_by_user_id, null);
  assert.equal(result.entity.archived_reason, null);
  assert.deepEqual(db.updates.map((entry) => entry.table), ['clients']);
  assert.equal(JSON.stringify(tables.roles), beforeRoles);
  assert.equal(JSON.stringify(tables.candidates), beforeCandidates);
  assert.equal(JSON.stringify(tables.client_members), beforeMembers);
});

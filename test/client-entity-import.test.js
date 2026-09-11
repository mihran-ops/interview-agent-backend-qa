'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateClientEntityImportRows } = require('../src/services/clientEntityImport');
const {
  assignImportedEntityMember,
  generateTemporaryPassword,
  processClientEntityImport,
} = require('../src/services/clientEntityImportService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.operation = 'select';
    this.payload = null;
    this.filters = [];
  }

  select(columns) {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    this.db.inserts.push({ table: this.table, payload });
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.db.resolve(this, true));
  }

  single() {
    return Promise.resolve(this.db.resolve(this, true));
  }

  then(resolve, reject) {
    return Promise.resolve(this.db.resolve(this, false)).then(resolve, reject);
  }
}

class FakeDb {
  constructor() {
    this.clients = [];
    this.clientMembers = [];
    this.inserts = [];
    this.nextClientId = 1;
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  resolve(query, single) {
    if (query.table === 'clients') {
      if (query.operation === 'insert') {
        const row = {
          id: `entity-${this.nextClientId++}`,
          ...query.payload,
        };
        this.clients.push(row);
        return { data: row, error: null };
      }
      return { data: single ? null : this.clients, error: null };
    }

    if (query.table === 'client_members') {
      if (query.operation === 'insert') {
        const duplicate = this.clientMembers.find((row) => (
          row.client_id === query.payload.client_id &&
          (row.email === query.payload.email || row.user_id === query.payload.user_id)
        ));
        if (duplicate) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }

        const row = {
          created_at: '2026-06-17T00:00:00.000Z',
          ...query.payload,
        };
        this.clientMembers.push(row);
        return { data: row, error: null };
      }

      const rows = this.clientMembers.filter((row) => (
        query.filters.every((filter) => row[filter.column] === filter.value)
      ));
      return { data: single ? (rows[0] || null) : rows, error: null };
    }

    return { data: single ? null : [], error: null };
  }
}

class FakeAuthAdmin {
  constructor(users = []) {
    this.users = users.map((user) => ({ ...user, email: String(user.email || '').toLowerCase() }));
    this.createCalls = [];
    this.inviteCalls = [];
    this.generateLinkCalls = [];
  }

  async listUsers({ email }) {
    const normalizedEmail = String(email || '').toLowerCase();
    return {
      data: {
        users: this.users.filter((user) => user.email === normalizedEmail),
      },
      error: null,
    };
  }

  async createUser(payload) {
    this.createCalls.push(payload);
    const normalizedEmail = String(payload.email || '').toLowerCase();
    const existing = this.users.find((user) => user.email === normalizedEmail);
    if (existing) {
      const error = new Error('User already exists');
      error.status = 422;
      throw error;
    }

    const user = {
      id: `auth-${this.users.length + 1}`,
      email: normalizedEmail,
      user_metadata: payload.user_metadata || {},
    };
    this.users.push(user);
    return { data: { user }, error: null };
  }

  async inviteUserByEmail() {
    this.inviteCalls.push([...arguments]);
    throw new Error('inviteUserByEmail should not be called by import');
  }

  async generateLink() {
    this.generateLinkCalls.push([...arguments]);
    throw new Error('generateLink should not be called by import');
  }
}

function parentClient(overrides = {}) {
  return {
    id: 'parent-1',
    name: 'Parent Client',
    email: 'billing@example.com',
    entity_label: 'office',
    candidate_assistance_contact: 'support@example.com',
    ...overrides,
  };
}

test('client entity import validation accepts revised member columns and normalizes role', () => {
  const rows = validateClientEntityImportRows([
    {
      name: ' Castle Rock Office ',
      location_type: ' Office ',
      location_user_name: ' Alex Manager ',
      location_user_email: 'Manager@Example.com ',
      member_role: 'Manager',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Castle Rock Office');
  assert.equal(rows[0].location_type, 'office');
  assert.equal(rows[0].location_user_name, 'Alex Manager');
  assert.equal(rows[0].location_user_email, 'manager@example.com');
  assert.equal(rows[0].member_role, 'manager');
  assert.deepEqual(rows[0].errors, []);
  assert.match(rows[0].warnings.join(' '), /No automatic emails/);
});

test('client entity import validation requires complete member fields', () => {
  const rows = validateClientEntityImportRows([
    { name: 'Missing Name Office', location_user_email: 'manager@example.com', member_role: 'Manager' },
    { name: 'Missing Email Office', location_user_name: 'Alex Manager', member_role: 'Manager' },
    { name: 'Missing Role Office', location_user_name: 'Alex Manager', location_user_email: 'manager@example.com' },
    { name: 'Bad Role Office', location_user_name: 'Alex Manager', location_user_email: 'manager@example.com', member_role: 'Owner' },
  ]);

  assert.match(rows[0].errors.join(' '), /Location user name is required/);
  assert.match(rows[1].errors.join(' '), /Location user email is required/);
  assert.match(rows[2].errors.join(' '), /Manager\/Member designation is required/);
  assert.match(rows[3].errors.join(' '), /blank, Manager, or Member/);
});

test('client entity import validation preserves duplicate entity behavior', () => {
  const rows = validateClientEntityImportRows([
    { name: 'Existing Office', location_type: 'Office' },
    { name: 'New Office', location_type: '', location_user_name: 'Jordan Member', location_user_email: 'member@example.com', member_role: 'Member' },
    { name: 'New Office', location_type: 'Office' },
  ], {
    existingNames: ['existing office'],
  });

  assert.equal(rows[0].skip_reason, 'duplicate_existing_entity');
  assert.deepEqual(rows[0].errors, []);
  assert.match(rows[1].errors.join(' '), /Duplicate entity name/);
  assert.match(rows[2].errors.join(' '), /Duplicate entity name/);
});

test('temporary password generator returns unique strong-looking values', () => {
  const first = generateTemporaryPassword();
  const second = generateTemporaryPassword();

  assert.notEqual(first, second);
  assert.ok(first.length >= 20);
  assert.match(first, /[A-Z]/);
  assert.match(first, /[a-z]/);
  assert.match(first, /[0-9]/);
});

test('import creates child entities and direct members without sending email', async () => {
  const db = new FakeDb();
  const authAdmin = new FakeAuthAdmin();

  const result = await processClientEntityImport({
    db,
    authAdmin,
    parent: parentClient(),
    rawRows: [
      {
        name: 'Castle Rock Office',
        location_type: 'Office',
        location_user_name: 'Alex Manager',
        location_user_email: 'manager@example.com',
        member_role: 'Manager',
      },
      {
        name: 'Denver Office',
        location_type: 'Office',
        location_user_name: 'Jordan Member',
        location_user_email: 'member@example.com',
        member_role: 'Member',
      },
    ],
    existingChildren: [],
  });

  assert.equal(result.counts.created, 2);
  assert.equal(result.counts.members_created, 2);
  assert.equal(result.counts.members_skipped, 0);
  assert.equal(result.counts.member_assignment_failed, 0);
  assert.equal(result.counts.auth_users_created, 2);
  assert.equal(result.counts.temporary_passwords_generated, 2);
  assert.equal(result.counts.emails_sent, 0);
  assert.equal(db.clients.length, 2);
  assert.equal(db.clients[0].parent_client_id, 'parent-1');
  assert.equal(db.clients[0].email, 'billing@example.com');
  assert.equal(db.clients[0].entity_label, 'office');
  assert.equal(db.clientMembers.length, 2);
  assert.equal(db.clientMembers[0].client_id, 'entity-1');
  assert.equal(db.clientMembers[0].role, 'manager');
  assert.equal(db.clientMembers[1].role, 'member');
  assert.equal(authAdmin.createCalls.length, 2);
  assert.equal(authAdmin.inviteCalls.length, 0);
  assert.equal(authAdmin.generateLinkCalls.length, 0);
  assert.ok(authAdmin.createCalls.every((call) => call.password && call.email_confirm === true));
  assert.equal(result.temporary_credentials.length, 2);
  assert.notEqual(result.temporary_credentials[0].temporary_password, result.temporary_credentials[1].temporary_password);
  assert.ok(result.temporary_credentials.every((credential) => credential.sensitive === true));
  assert.ok(result.temporary_credentials.every((credential) => credential.force_reset_supported === false));
  assert.ok(result.temporary_credentials.every((credential) => credential.force_reset_metadata_set === true));
  assert.deepEqual(
    db.inserts.map((insert) => insert.table),
    ['clients', 'client_members', 'clients', 'client_members'],
  );
});

test('duplicate direct member assignment is skipped without creating auth user', async () => {
  const db = new FakeDb();
  const authAdmin = new FakeAuthAdmin();
  db.clientMembers.push({
    client_id: 'entity-1',
    user_id: 'auth-existing',
    email: 'member@example.com',
    name: 'Existing Member',
    role: 'member',
  });

  const result = await assignImportedEntityMember({
    db,
    authAdmin,
    clientId: 'entity-1',
    email: 'member@example.com',
    name: 'Jordan Member',
    role: 'member',
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.code, 'MEMBER_ALREADY_ASSIGNED');
  assert.equal(result.temporary_password, null);
  assert.equal(authAdmin.createCalls.length, 0);
  assert.equal(db.clientMembers.length, 1);
});

test('existing auth user assignment does not return a temporary password', async () => {
  const db = new FakeDb();
  const authAdmin = new FakeAuthAdmin([{ id: 'auth-existing', email: 'member@example.com' }]);

  const result = await assignImportedEntityMember({
    db,
    authAdmin,
    clientId: 'entity-1',
    email: 'member@example.com',
    name: 'Jordan Member',
    role: 'member',
  });

  assert.equal(result.status, 'created');
  assert.equal(result.auth_user_created, false);
  assert.equal(result.temporary_password, null);
  assert.equal(result.force_reset_supported, false);
  assert.equal(result.force_reset_metadata_set, false);
  assert.equal(result.emails_sent, 0);
  assert.equal(authAdmin.createCalls.length, 0);
  assert.equal(db.clientMembers[0].user_id, 'auth-existing');
});

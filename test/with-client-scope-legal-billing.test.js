const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const {
  canManageMembersForClient,
  canViewLegalBillingForClient
} = require('../src/services/clientScope');

const projectRoot = path.join(__dirname, '..');
const authPath = path.join(projectRoot, 'src', 'middleware', 'auth.js');
const supabaseClientPath = path.join(projectRoot, 'src', 'clients', 'supabase.js');

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.limitValue = null;
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ op: 'in', column, values: Array.isArray(values) ? values : [] });
    return this;
  }

  is(column, value) {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  limit(value) {
    this.limitValue = Number(value) || null;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  execute() {
    let rows = [];
    if (this.table === 'client_members') {
      rows = this.db.members.map((member) => ({
        ...member,
        clients: this.db.clients.find((client) => client.id === member.client_id) || null
      }));
    } else if (this.table === 'clients') {
      rows = this.db.clients.slice();
    }

    for (const filter of this.filters) {
      if (filter.op === 'eq') {
        rows = rows.filter((row) => row[filter.column] === filter.value);
      } else if (filter.op === 'in') {
        rows = rows.filter((row) => filter.values.includes(row[filter.column]));
      } else if (filter.op === 'is') {
        rows = rows.filter((row) => (row[filter.column] ?? null) === filter.value);
      }
    }
    if (this.limitValue) rows = rows.slice(0, this.limitValue);
    return { data: rows, error: null };
  }
}

function loadWithClientScope({ members, clients }) {
  delete require.cache[authPath];
  delete require.cache[supabaseClientPath];

  const db = {
    members,
    clients,
    from(table) {
      return new Query(this, table);
    }
  };

  require.cache[supabaseClientPath] = {
    id: supabaseClientPath,
    filename: supabaseClientPath,
    loaded: true,
    exports: {
      supabaseAdmin: db,
      supabaseAnon: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
      supabase: db
    }
  };

  return require(authPath).withClientScope;
}

function baseClients() {
  return [
    { id: 'parent-client', name: 'Retail Parent', parent_client_id: null, entity_label: null, archived_at: null },
    { id: 'child-client', name: 'Retail Child', parent_client_id: 'parent-client', entity_label: 'location', archived_at: null },
    { id: 'sibling-client', name: 'Retail Sibling', parent_client_id: 'parent-client', entity_label: 'location', archived_at: null }
  ];
}

function makeReq({ userId, selectedClientId, isAdmin = false }) {
  return {
    user: { id: userId, email: `${userId}@example.com` },
    isAdmin,
    isGlobalAdmin: isAdmin,
    query: selectedClientId ? { client_id: selectedClientId } : {},
    body: {},
    headers: {},
    header: () => ''
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function runScope({ members, userId, selectedClientId, isAdmin = false }) {
  const withClientScope = loadWithClientScope({ members, clients: baseClients() });
  const req = makeReq({ userId, selectedClientId, isAdmin });
  const res = makeRes();
  let nextCalled = false;
  await withClientScope(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  return req;
}

test('withClientScope keeps legal-billing maps for parent retail manager', async () => {
  const req = await runScope({
    userId: 'parent-manager',
    selectedClientId: 'parent-client',
    members: [{ user_id_uuid: 'parent-manager', client_id: 'parent-client', role: 'manager' }]
  });

  assert.equal(req.clientScope.effectiveRolesByClientId['parent-client'].includes('manager'), true);
  assert.equal(canViewLegalBillingForClient(req.clientScope, 'parent-client'), true);
  assert.equal(canManageMembersForClient(req.clientScope, 'child-client'), true);
  assert.equal(req.clientScope.permissionsByClientId['child-client'].can_manage_members, true);
});

test('withClientScope lets parent manager selected on child resolve legal billing to parent', async () => {
  const req = await runScope({
    userId: 'parent-manager',
    selectedClientId: 'child-client',
    members: [{ user_id_uuid: 'parent-manager', client_id: 'parent-client', role: 'manager' }]
  });

  assert.equal(req.client?.id, 'child-client');
  assert.equal(canViewLegalBillingForClient(req.clientScope, 'child-client'), true);
  assert.equal(canViewLegalBillingForClient(req.clientScope, 'parent-client'), true);
  assert.equal(canManageMembersForClient(req.clientScope, 'child-client'), true);
});

test('withClientScope keeps regular members blocked from legal billing', async () => {
  const req = await runScope({
    userId: 'regular-member',
    selectedClientId: 'parent-client',
    members: [{ user_id_uuid: 'regular-member', client_id: 'parent-client', role: 'member' }]
  });

  assert.equal(canViewLegalBillingForClient(req.clientScope, 'parent-client'), false);
});

test('withClientScope keeps child-only managers blocked from parent legal billing', async () => {
  const req = await runScope({
    userId: 'child-manager',
    selectedClientId: 'child-client',
    members: [{ user_id_uuid: 'child-manager', client_id: 'child-client', role: 'manager' }]
  });

  assert.equal(canViewLegalBillingForClient(req.clientScope, 'child-client'), false);
  assert.equal(canViewLegalBillingForClient(req.clientScope, 'parent-client'), false);
  assert.equal(canManageMembersForClient(req.clientScope, 'child-client'), true);
  assert.equal(canManageMembersForClient(req.clientScope, 'parent-client'), false);
  assert.equal(canManageMembersForClient(req.clientScope, 'sibling-client'), false);
});

test('withClientScope preserves admin bypass state', async () => {
  const req = await runScope({
    userId: 'admin-user',
    selectedClientId: 'parent-client',
    isAdmin: true,
    members: []
  });

  assert.equal(req.isAdmin, true);
  assert.equal(req.isGlobalAdmin, true);
  assert.equal(req.client?.id, 'parent-client');
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const authPath = path.join(projectRoot, 'src', 'middleware', 'auth.js');
const supabaseClientPath = path.join(projectRoot, 'src', 'clients', 'supabase.js');

class AdminQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = {};
  }

  select() { return this; }

  eq(column, value) {
    this.filters[column] = value;
    return this;
  }

  async maybeSingle() {
    if (this.table !== 'admins') return { data: null, error: null };
    this.db.adminLookupCount += 1;
    const row = this.db.admins.find((admin) => (
      Object.entries(this.filters).every(([column, value]) => admin[column] === value)
    ));
    return { data: row || null, error: null };
  }
}

function makeAdminDb(admins = []) {
  return {
    admins,
    adminLookupCount: 0,
    from(table) {
      return new AdminQuery(this, table);
    }
  };
}

function loadAuth({ authResult, admins = [] }) {
  delete require.cache[authPath];
  delete require.cache[supabaseClientPath];

  const adminDb = makeAdminDb(admins);
  const authClient = {
    calls: [],
    auth: {
      getUser: async (token) => {
        authClient.calls.push(token);
        return typeof authResult === 'function' ? authResult(token) : authResult;
      }
    }
  };

  require.cache[supabaseClientPath] = {
    id: supabaseClientPath,
    filename: supabaseClientPath,
    loaded: true,
    exports: {
      supabaseAdmin: adminDb,
      supabaseAnon: authClient,
      supabase: adminDb
    }
  };

  return {
    ...require(authPath),
    adminDb,
    authClient
  };
}

function makeReq(token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    headers,
    header(name) {
      return headers[String(name || '').toLowerCase()] || '';
    }
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

test('requireAuth verifies Supabase access token before setting req.user', async () => {
  const { requireAuth, authClient } = loadAuth({
    authResult: {
      data: { user: { id: 'user-valid', email: 'buyer@example.com' } },
      error: null
    }
  });
  const req = makeReq('valid-token');
  const res = makeRes();
  let nextCalled = false;

  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(authClient.calls, ['valid-token']);
  assert.deepEqual(req.user, { id: 'user-valid', email: 'buyer@example.com' });
  assert.equal(req.userToken, 'valid-token');
  assert.equal(req.isAdmin, false);
});

test('requireAuth returns 401 when bearer token is missing', async () => {
  const { requireAuth, authClient } = loadAuth({
    authResult: {
      data: { user: { id: 'should-not-run' } },
      error: null
    }
  });
  const req = makeReq('');
  const res = makeRes();
  let nextCalled = false;

  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Missing bearer token');
  assert.deepEqual(authClient.calls, []);
  assert.equal(req.user, undefined);
});

test('requireAuth returns 401 for malformed or forged tokens and does not set req.user', async () => {
  const { requireAuth, adminDb } = loadAuth({
    authResult: {
      data: { user: null },
      error: { message: 'invalid jwt' }
    },
    admins: [{ email: 'admin@example.com', is_active: true }]
  });
  const req = makeReq('not-a-real-jwt');
  const res = makeRes();
  let nextCalled = false;

  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Invalid token');
  assert.equal(req.user, undefined);
  assert.equal(adminDb.adminLookupCount, 0);
});

test('admin identity is based only on verified Supabase user email', async () => {
  const { requireAuth, adminDb } = loadAuth({
    authResult: {
      data: { user: { id: 'admin-user', email: 'admin@example.com' } },
      error: null
    },
    admins: [{ email: 'admin@example.com', is_active: true }]
  });
  const req = makeReq('verified-admin-token');
  const res = makeRes();

  await requireAuth(req, res, () => {});

  assert.equal(req.isAdmin, true);
  assert.equal(req.isGlobalAdmin, true);
  assert.equal(adminDb.adminLookupCount, 1);
});

test('auth middleware does not use decode-only JWT trust', () => {
  const source = fs.readFileSync(authPath, 'utf8');
  assert.doesNotMatch(source, /jwt\.decode/);
  assert.match(source, /\.auth\.getUser\(token\)/);
});

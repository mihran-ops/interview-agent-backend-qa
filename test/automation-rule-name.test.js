'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

const projectRoot = path.resolve(__dirname, '..');
const routePath = path.join(projectRoot, 'src', 'routes', 'automation', 'index.js');
const supabaseClientPath = path.join(projectRoot, 'src', 'lib', 'supabaseClient.js');
const authMiddlewarePath = path.join(projectRoot, 'src', 'middleware', 'auth.js');
const mailerPath = path.join(projectRoot, 'utils', 'mailer.js');

const baseRule = {
  id: 'rule-1',
  name: 'Existing rule',
  client_id: 'client-1',
  role_id: 'role-1',
  enabled: false,
  mode: 'daily_digest_pending_approval',
  criteria_config: {},
  action_config: {},
  digest_config: {},
  rule_version: 1,
  created_by_user_id: null,
  created_by_email: null,
  updated_by_user_id: null,
  updated_by_email: null,
  archived_at: null,
  created_at: '2026-06-16T00:00:00.000Z',
  updated_at: '2026-06-16T00:00:00.000Z',
};

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.payload = null;
    this.selectedColumns = '';
  }

  select(columns) {
    this.selectedColumns = columns;
    this.db.selects.push({ table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  is(column, value) {
    this.filters.push({ op: 'is', column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ op: 'in', column, value });
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    this.db.inserts.push({ table: this.table, payload });
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    this.db.updates.push({ table: this.table, payload });
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.db.resolve(this, true));
  }

  then(resolve, reject) {
    return Promise.resolve(this.db.resolve(this, false)).then(resolve, reject);
  }
}

class FakeDb {
  constructor() {
    this.role = { id: 'role-1', client_id: 'client-1', title: 'Account Executive' };
    this.rule = { ...baseRule };
    this.inserts = [];
    this.updates = [];
    this.selects = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  resolve(query, single) {
    if (query.table === 'roles') {
      return { data: this.role, error: null };
    }

    if (query.table !== 'automation_rules') {
      return { data: single ? null : [], error: null };
    }

    if (query.operation === 'insert') {
      return {
        data: {
          ...baseRule,
          id: 'created-rule',
          ...query.payload,
        },
        error: null,
      };
    }

    if (query.operation === 'update') {
      return {
        data: {
          ...this.rule,
          ...query.payload,
        },
        error: null,
      };
    }

    if (single) {
      return { data: this.rule, error: null };
    }

    return { data: [this.rule], error: null };
  }
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function buildApp(db) {
  // The router is assembled from several files that each cache the modules stubbed
  // below, so every first-party module reloads on each build.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(projectRoot) && !cached.includes('node_modules')) {
      delete require.cache[cached]
    }
  }
  delete require.cache[routePath];
  delete require.cache[supabaseClientPath];
  delete require.cache[authMiddlewarePath];
  delete require.cache[mailerPath];

  injectModule(supabaseClientPath, { supabaseAdmin: db });
  injectModule(authMiddlewarePath, {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'user-1', email: 'user@example.com' };
      req.isGlobalAdmin = true;
      req.isAdmin = true;
      return next();
    },
    withClientScope: (_req, _res, next) => next(),
  });
  injectModule(mailerPath, {});

  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/automation', router);
  return app;
}

async function request(app, method, pathname, body = null) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createRulePayload(overrides = {}) {
  return {
    client_id: 'client-1',
    role_id: 'role-1',
    enabled: true,
    criteria_config: {},
    action_config: {},
    digest_config: {},
    ...overrides,
  };
}

test('POST /api/automation/rules accepts and returns name', async () => {
  const db = new FakeDb();
  const app = buildApp(db);

  const result = await request(app, 'POST', '/api/automation/rules', createRulePayload({
    name: 'Second-round approvals',
  }));

  assert.equal(result.status, 201);
  assert.equal(result.body.item.name, 'Second-round approvals');
  assert.equal(db.inserts[0].payload.name, 'Second-round approvals');
});

test('POST /api/automation/rules trims name whitespace', async () => {
  const db = new FakeDb();
  const app = buildApp(db);

  const result = await request(app, 'POST', '/api/automation/rules', createRulePayload({
    name: '  Second   round\tapprovals  ',
  }));

  assert.equal(result.status, 201);
  assert.equal(result.body.item.name, 'Second round approvals');
  assert.equal(db.inserts[0].payload.name, 'Second round approvals');
});

test('POST /api/automation/rules rejects invalid supplied names', async () => {
  const cases = [
    { name: 'blank', value: '   ', code: 'automation_rule_name_required' },
    { name: 'null', value: null, code: 'automation_rule_name_required' },
    { name: 'non-string', value: 42, code: 'invalid_automation_rule_name' },
    { name: 'too-long', value: 'a'.repeat(121), code: 'automation_rule_name_too_long' },
  ];

  for (const item of cases) {
    const db = new FakeDb();
    const result = await request(buildApp(db), 'POST', '/api/automation/rules', createRulePayload({
      name: item.value,
    }));

    assert.equal(result.status, 400, item.name);
    assert.equal(result.body.code, item.code, item.name);
    assert.equal(db.inserts.length, 0, item.name);
  }
});

test('POST /api/automation/rules defaults omitted name for backward compatibility', async () => {
  const db = new FakeDb();
  const app = buildApp(db);

  const result = await request(app, 'POST', '/api/automation/rules', createRulePayload());

  assert.equal(result.status, 201);
  assert.equal(result.body.item.name, 'Automation rule');
  assert.equal(db.inserts[0].payload.name, 'Automation rule');
});

test('GET /api/automation/rules includes name in select and response', async () => {
  const db = new FakeDb();
  db.rule = { ...baseRule, name: 'Listed rule' };
  const app = buildApp(db);

  const result = await request(app, 'GET', '/api/automation/rules?client_id=client-1');

  assert.equal(result.status, 200);
  assert.equal(result.body.items[0].name, 'Listed rule');
  assert.match(db.selects.find((entry) => entry.table === 'automation_rules').columns, /\bname\b/);
});

test('PATCH /api/automation/rules/:id updates name', async () => {
  const db = new FakeDb();
  const app = buildApp(db);

  const result = await request(app, 'PATCH', '/api/automation/rules/rule-1', {
    name: '  Updated\tRule  ',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.item.name, 'Updated Rule');
  assert.deepEqual(db.updates[0].payload.name, 'Updated Rule');
  assert.deepEqual(Object.keys(db.updates[0].payload).sort(), [
    'name',
    'updated_at',
    'updated_by_email',
    'updated_by_user_id',
  ]);
});

test('PATCH /api/automation/rules/:id rejects invalid supplied names', async () => {
  const cases = [
    { name: 'blank', value: '   ', code: 'automation_rule_name_required' },
    { name: 'null', value: null, code: 'automation_rule_name_required' },
    { name: 'non-string', value: 42, code: 'invalid_automation_rule_name' },
    { name: 'too-long', value: 'a'.repeat(121), code: 'automation_rule_name_too_long' },
  ];

  for (const item of cases) {
    const db = new FakeDb();
    const result = await request(buildApp(db), 'PATCH', '/api/automation/rules/rule-1', {
      name: item.value,
    });

    assert.equal(result.status, 400, item.name);
    assert.equal(result.body.code, item.code, item.name);
    assert.equal(db.updates.length, 0, item.name);
  }
});

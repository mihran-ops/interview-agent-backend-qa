'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');
const express = require('express');

const ID = Object.freeze({
  client: '76000000-0000-4000-8000-000000000001',
  role: '76000000-0000-4000-8000-000000000002',
});

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.operation = 'select';
    this.filters = new Map();
  }
  select() { return this; }
  eq(key, value) { this.filters.set(key, String(value)); return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  single() { return Promise.resolve(this.db.resolve(this)); }
  maybeSingle() { return Promise.resolve(this.db.resolve(this)); }
  then(resolve, reject) { return Promise.resolve(this.db.resolve(this)).then(resolve, reject); }
}

function createDb() {
  return {
    updates: [],
    from(table) { return new Query(this, table); },
    resolve(query) {
      if (query.table !== 'roles' || query.filters.get('id') !== ID.role) {
        return { data: null, error: null };
      }
      if (query.operation === 'update') this.updates.push({ table: query.table, value: query.value });
      return { data: { id: ID.role, client_id: ID.client, kb_document_id: query.value?.kb_document_id || null }, error: null };
    },
    storage: {
      from() {
        return {
          upload: async () => ({ data: { path: 'synthetic' }, error: null }),
        };
      },
    },
  };
}

async function withRouter(routeName, db, callback) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const parentFile = parent?.filename || '';
    if (request === '../src/clients/supabase' && parentFile.includes(`/routes/${routeName}.js`)) {
      return { supabaseAdmin: db, supabase: db };
    }
    if (request === '../src/middleware/auth' && parentFile.includes(`/routes/${routeName}.js`)) {
      return {
        requireAuth: (_req, _res, next) => next(),
        withClientScope: (_req, _res, next) => next(),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve(`../routes/${routeName}`);
  delete require.cache[modulePath];
  try {
    const router = require(`../routes/${routeName}`);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const membership = { client_id: ID.client, role: 'member' };
      req.user = { id: 'member-a' };
      req.client = { id: ID.client };
      req.clientIds = [ID.client];
      req.client_memberships = [ID.client];
      req.memberships = [membership];
      req.clientScope = {
        memberships: [membership],
        accessibleClientIds: [ID.client],
        effectiveRolesByClientId: { [ID.client]: ['member'] },
        defaultClientId: ID.client,
      };
      next();
    });
    app.use('/', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

test('Finding #2 red: an ordinary member cannot attach a KB document through the service role', async () => {
  const db = createDb();
  await withRouter('kb', db, async (base) => {
    const response = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: ID.role, kb_document_id: 'kb-synthetic' }),
    });
    assert.equal(response.status, 403);
    assert.equal(db.updates.length, 0);
  });
});

test('Finding #2 red: an ordinary member is denied before legacy JD upload processing', async () => {
  const db = createDb();
  await withRouter('rolesUpload', db, async (base) => {
    const response = await fetch(`${base}/upload-jd?client_id=${ID.client}&role_id=${ID.role}`, {
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.equal(db.updates.length, 0);
  });
});

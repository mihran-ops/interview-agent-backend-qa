'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createProfileRouter, normalizeFullName } = require('../routes/profile');

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeDb(error = null) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const call = { table, payload: null, filter: null, select: null };
      calls.push(call);
      return {
        update(payload) {
          call.payload = payload;
          return this;
        },
        or(filter) {
          call.filter = filter;
          return this;
        },
        async select(columns) {
          call.select = columns;
          return error
            ? { data: null, error }
            : { data: [{ client_id: 'client-a' }, { client_id: 'client-b' }], error: null };
        },
      };
    },
  };
  return db;
}

async function withServer({ db, user, body }, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/auth/profile', createProfileRouter({ db }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/auth/profile/sync`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    await run(response, text ? JSON.parse(text) : null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('normalizes a display name without changing its words', () => {
  assert.equal(normalizeFullName('  Jason   Gardner  '), 'Jason Gardner');
});

test('authenticated profile sync updates only rows tied to the verified user id', async () => {
  const db = makeDb();
  await withServer({
    db,
    user: { id: USER_ID, email: 'Jason@Example.com' },
    body: { full_name: '  Jason   Gardner ' },
  }, async (response, body) => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.equal(body.item.memberships_updated, 2);
    assert.deepEqual(body.item, {
      full_name: 'Jason Gardner',
      email: 'jason@example.com',
      name_updated: true,
      memberships_updated: 2,
    });
  });

  assert.deepEqual(db.calls, [{
    table: 'client_members',
    payload: { name: 'Jason Gardner', email: 'jason@example.com' },
    filter: `user_id.eq.${USER_ID},user_id_uuid.eq.${USER_ID}`,
    select: 'client_id',
  }]);
});

test('email-only profile sync cannot overwrite an existing member name', async () => {
  const db = makeDb();
  await withServer({
    db,
    user: { id: USER_ID, email: 'Confirmed@Example.com' },
    body: {},
  }, async (response, body) => {
    assert.equal(response.status, 200);
    assert.deepEqual(body.item, {
      full_name: null,
      email: 'confirmed@example.com',
      name_updated: false,
      memberships_updated: 2,
    });
  });

  assert.deepEqual(db.calls, [{
    table: 'client_members',
    payload: { email: 'confirmed@example.com' },
    filter: `user_id.eq.${USER_ID},user_id_uuid.eq.${USER_ID}`,
    select: 'client_id',
  }]);
});

test('profile sync rejects invalid names before touching the database', async () => {
  const db = makeDb();
  await withServer({
    db,
    user: { id: USER_ID, email: 'jason@example.com' },
    body: { full_name: ' '.repeat(5) },
  }, async (response, body) => {
    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_full_name');
  });
  assert.equal(db.calls.length, 0);
});

test('application mounts profile sync behind existing authentication and client scope', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'client', 'auth.js'), 'utf8');
  assert.match(
    source,
    /router\.use\('\/auth\/profile', requireAuth, withClientScope, createProfileRouter\(\{ db: supabaseAdmin \}\)\)/,
  );
});

'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { createRequireSalesRep } = require('../src/middleware/salesAuth')

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function fakeDb(results = {}, calls = []) {
  return {
    from(table) {
      calls.push(table)
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return results[table] || { data: null, error: null } }
      }
    }
  }
}

test('sales authorization requires an authenticated user', async () => {
  const res = responseRecorder()
  const calls = []
  await createRequireSalesRep({ db: fakeDb({}, calls) })({ user: null }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'authentication_required')
  assert.deepEqual(calls, [])
})

test('sales authorization rejects users without an active rep or global-admin record', async () => {
  const res = responseRecorder()
  const calls = []
  await createRequireSalesRep({ db: fakeDb({}, calls) })({ user: { id: 'user-2', email: 'user@example.com' } }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'sales_access_denied')
  assert.deepEqual(calls, ['sales_reps', 'admins'])
})

test('sales authorization gives an active rep precedence and attaches safe fields', async () => {
  const req = { user: { id: 'user-1' } }
  const res = responseRecorder()
  const calls = []
  let nextCalled = false
  await createRequireSalesRep({ db: fakeDb({
    sales_reps: { data: { user_id: 'user-1', email: 'rep@example.com', display_name: 'Rep One', active: true }, error: null },
    admins: { data: { id: 'admin-1', is_active: true }, error: null }
  }, calls) })(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.deepEqual(req.salesRep, { user_id: 'user-1', email: 'rep@example.com', display_name: 'Rep One', access_role: 'sales_rep' })
  assert.deepEqual(calls, ['sales_reps'])
})

test('sales authorization accepts an active global admin by the same verified email used by admin auth', async () => {
  const req = { user: { id: 'admin-user-1', email: 'Admin@example.com' } }
  const res = responseRecorder()
  const calls = []
  let nextCalled = false
  await createRequireSalesRep({ db: fakeDb({
    admins: { data: { id: 'admin-row-1', is_active: true }, error: null }
  }, calls) })(req, res, () => { nextCalled = true })
  assert.equal(nextCalled, true)
  assert.deepEqual(req.salesRep, {
    user_id: 'admin-user-1',
    email: 'Admin@example.com',
    display_name: 'Global Admin',
    access_role: 'global_admin'
  })
  assert.deepEqual(calls, ['sales_reps', 'admins'])
})

test('sales authorization fails closed when global-admin lookup is unavailable', async () => {
  const res = responseRecorder()
  await createRequireSalesRep({ db: fakeDb({
    admins: { data: null, error: { code: 'database_unavailable' } }
  }) })({ user: { id: 'admin-user-1', email: 'admin@example.com' } }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, 'sales_access_unavailable')
})

test('sales authorization does not attempt email-based admin access without a verified email', async () => {
  const res = responseRecorder()
  const calls = []
  await createRequireSalesRep({ db: fakeDb({}, calls) })({ user: { id: 'user-3' } }, res, () => assert.fail('next should not run'))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(calls, ['sales_reps'])
})

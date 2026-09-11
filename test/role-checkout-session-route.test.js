'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

const appPath = path.join(__dirname, '..', 'app.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
const authPath = path.join(__dirname, '..', 'src', 'middleware', 'auth.js')
const generateRubricPath = path.join(__dirname, '..', 'generateRubric.js')
const stripePath = require.resolve('stripe')
// The app now takes its Stripe client from lib/stripeClient.js, which caches the
// constructed instance; it must be dropped too so each build sees this test's stub.
const stripeClientPath = path.join(__dirname, '..', 'lib', 'stripeClient.js')
const dotenvPath = require.resolve('dotenv')

const ROUTE_STUBS = [
  'routes/dashboard.js',
  'routes/roles.js',
  'routes/automation.js',
  'routes/webhookStripe.js',
  'routes/webhookSendgrid.js',
  'routes/webhook.js',
  'routes/candidateSubmit.js',
  'routes/verifyOtp.js',
  'routes/createTavusInterview.js',
  'routes/accommodationRequests.js',
  'routes/textInterview.js',
  'routes/clientMembersScoped.js',
  'routes/feedback.js',
  'routes/alphaScreenPackages.js',
  'routes/publicAnalytics.js',
  'routes/publicLeads.js',
  'routes/adminBilling.js',
  'routes/kb.js',
  'routes/tavus.js',
  'routes/publicInterviewStatus.js',
  'routes/membershipAgreementsPublic.js',
  'routes/rolesUpload.js',
  'routes/files.js',
  'routes/reports.js',
  'routes/reportsPdf.js'
]

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    const value = row?.[filter.column]
    if (filter.type === 'is') {
      return filter.value === null ? value === null || value === undefined : value === filter.value
    }
    return String(value ?? '') === String(filter.value ?? '')
  })
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.insertPayload = null
    this.updatePayload = null
    this.limitCount = null
  }

  select() { return this }
  order() { return this }

  limit(count) {
    this.limitCount = Number(count || 0)
    return this
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value })
    return this
  }

  is(column, value) {
    this.filters.push({ type: 'is', column, value })
    return this
  }

  in() { return this }
  not() { return this }

  insert(payload) {
    this.insertPayload = { ...(payload || {}) }
    return this
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) }
    return this
  }

  rows() {
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'client_plan_settings') return this.db.planSettings
    if (this.table === 'client_role_credits') return this.db.clientRoleCredits
    if (this.table === 'pending_role_purchases') return this.db.pendingRolePurchases
    if (this.table === 'roles') return this.db.roles
    return []
  }

  filteredRows() {
    let rows = this.rows().filter((row) => matchesFilters(row, this.filters))
    if (this.limitCount) rows = rows.slice(0, this.limitCount)
    return rows
  }

  async maybeSingle() {
    if (this.updatePayload) {
      const result = await this.execute()
      return { data: result.data?.[0] || null, error: result.error || null }
    }
    return { data: this.filteredRows()[0] || null, error: null }
  }

  async single() {
    if (this.insertPayload) {
      if (this.table === 'roles' && this.db.roleInsertError) {
        return { data: null, error: { message: this.db.roleInsertError } }
      }
      const row = { ...this.insertPayload }
      if (this.table === 'pending_role_purchases' && !row.id) row.id = `pending-${this.db.pendingRolePurchases.length + 1}`
      if (this.table === 'roles' && !row.id) row.id = `role-${this.db.roles.length + 1}`
      this.rows().push(row)
      this.db.writes.push({ table: this.table, type: 'insert', row })
      return { data: row, error: null }
    }
    return this.maybeSingle()
  }

  async execute() {
    if (this.insertPayload) return this.single()
    if (this.updatePayload) {
      const rows = this.filteredRows()
      for (const row of rows) Object.assign(row, this.updatePayload)
      this.db.writes.push({ table: this.table, type: 'update', rows, payload: this.updatePayload })
      return { data: rows, error: null }
    }
    return { data: this.filteredRows(), error: null }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeStripe(db) {
  return {
    customers: {
      retrieve: async (id) => {
        db.stripeCalls.customersRetrieve.push(id)
        return { id }
      },
      list: async (payload) => {
        db.stripeCalls.customersList.push(payload)
        return { data: [] }
      },
      create: async (payload) => {
        db.stripeCalls.customersCreate.push(payload)
        return { id: `cus_created_${db.stripeCalls.customersCreate.length}` }
      }
    },
    prices: {
      create: async (payload) => {
        db.stripeCalls.pricesCreate.push(payload)
        return { id: `price_role_${db.stripeCalls.pricesCreate.length}` }
      }
    },
    checkout: {
      sessions: {
        create: async (payload) => {
          db.stripeCalls.sessionsCreate.push(payload)
          const index = db.stripeCalls.sessionsCreate.length
          return { id: `cs_role_${index}`, url: `https://checkout.stripe.test/cs_role_${index}` }
        }
      }
    }
  }
}

function makeDb(options = {}) {
  const parentId = options.parentId || 'parent-client'
  const childId = options.childId || 'child-client'
  const db = {
    clients: options.clients || [
      {
        id: parentId,
        name: 'Alpha Dental',
        email: 'billing@alpha.example',
        parent_client_id: null,
        billing_status: 'active',
        access_override_mode: null,
        stripe_customer_id: 'cus_existing'
      },
      {
        id: childId,
        name: 'Alpha East',
        email: 'east@alpha.example',
        parent_client_id: parentId,
        billing_status: 'active',
        access_override_mode: null,
        stripe_customer_id: null
      }
    ],
    planSettings: options.planSettings || [{
      client_id: parentId,
      plan_tier: 'basic',
      billing_interval: 'monthly',
      per_role_fee: 399
    }],
    clientRoleCredits: options.clientRoleCredits || [],
    pendingRolePurchases: [],
    roles: [],
    writes: [],
    rpcCalls: [],
    rubricCalls: [],
    storageUploads: [],
    rpcMode: options.rpcMode || 'claim',
    roleInsertError: options.roleInsertError || null,
    stripeConstructs: [],
    stripeCalls: {
      customersRetrieve: [],
      customersList: [],
      customersCreate: [],
      pricesCreate: [],
      sessionsCreate: []
    },
    from(table) {
      return new FakeQuery(this, table)
    },
    storage: {
      from: (bucket) => ({
        upload: async (objectKey, buffer, uploadOptions) => {
          db.storageUploads.push({ bucket, objectKey, bytes: buffer?.length || 0, uploadOptions })
          return { data: { path: objectKey }, error: null }
        }
      })
    },
    async rpc(name, args) {
      this.rpcCalls.push({ name, args })
      if (name !== 'claim_first_role_prepay_credit') {
        return { data: null, error: { message: 'unknown_rpc' } }
      }
      if (this.rpcMode === 'error') {
        return { data: null, error: { message: 'claim_failed' } }
      }
      if (this.rpcMode === 'race') {
        return { data: [{ ok: false, credit_id: null, status: 'credit_not_available' }], error: null }
      }
      const credit = this.clientRoleCredits.find((row) => {
        return row.billing_client_id === args.p_billing_client_id &&
          row.credit_type === 'first_role_prepay' &&
          row.status === 'unused' &&
          !row.used_at &&
          !row.used_by_role_id
      })
      if (!credit) {
        return { data: [{ ok: false, credit_id: null, status: 'credit_not_available' }], error: null }
      }
      credit.status = 'claimed'
      credit.source_client_id = credit.source_client_id || args.p_source_client_id
      credit.metadata = {
        ...(credit.metadata || {}),
        claimed_by: args.p_claim_context,
        claimed_client_id: args.p_source_client_id,
        claimed_at: '2026-06-26T12:00:00.000Z'
      }
      this.writes.push({ table: 'client_role_credits', type: 'rpc_claim', row: credit })
      return { data: [{ ok: true, credit_id: credit.id, status: 'claimed' }], error: null }
    }
  }
  db.stripe = makeStripe(db)
  return db
}

function stubRouteModules() {
  for (const relative of ROUTE_STUBS) {
    const filename = path.join(__dirname, '..', relative)
    injectModule(filename, express.Router())
  }
}

function buildApp(db) {
  for (const filename of [
    appPath,
    supabaseClientPath,
    authPath,
    generateRubricPath,
    stripePath,
    stripeClientPath,
    dotenvPath,
    ...ROUTE_STUBS.map((relative) => path.join(__dirname, '..', relative))
  ]) {
    delete require.cache[filename]
  }

  stubRouteModules()
  injectModule(dotenvPath, { config: () => ({ parsed: {} }) })
  injectModule(supabaseClientPath, { supabase: db, supabaseAdmin: db, supabaseAnon: db })
  injectModule(authPath, {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'user-1', email: 'user@example.test' }
      req.isAdmin = true
      req.isGlobalAdmin = true
      next()
    },
    withClientScope: (req, _res, next) => {
      req.client_memberships = db.clients.map((client) => client.id)
      req.clientIds = req.client_memberships
      req.memberships = db.clients.map((client) => ({ client_id: client.id, role: 'admin', name: client.name }))
      next()
    }
  })
  injectModule(generateRubricPath, {
    generateRubricAndKBForRole: async (roleId) => {
      db.rubricCalls.push(roleId)
    },
    makeKBFromRubric: async () => ({})
  })
  injectModule(stripePath, function Stripe(secret) {
    db.stripeConstructs.push(secret)
    return db.stripe
  })

  const originalListen = express.application.listen
  const originalLog = console.log
  express.application.listen = function listenStub() {
    return { close: () => {} }
  }
  console.log = () => {}
  try {
    return require(appPath)
  } finally {
    express.application.listen = originalListen
    console.log = originalLog
  }
}

async function postRoleCheckout(app, clientId, overrides = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const form = new FormData()
    form.append('client_id', clientId)
    form.append('role_title', overrides.roleTitle || 'Dental Hygienist')
    form.append('interview_type', overrides.interviewType || 'BASIC')
    form.append('embedded', overrides.embedded || 'false')
    form.append('file', new Blob([Buffer.from('%PDF-1.4 test jd')], { type: 'application/pdf' }), overrides.filename || 'jd.pdf')
    const response = await fetch(`http://127.0.0.1:${port}/clients/roles/checkout-session`, {
      method: 'POST',
      body: form
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

test('role checkout consumes unused first-role credit without Stripe checkout or pending purchase', async () => {
  const db = makeDb({
    clientRoleCredits: [{
      id: 'credit-1',
      billing_client_id: 'parent-client',
      source_client_id: 'parent-client',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null
    }]
  })
  const response = await postRoleCheckout(buildApp(db), 'parent-client')

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.credit_applied, true)
  assert.match(response.body.role_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(response.body.message, 'First-role prepay credit applied.')
  assert.equal(db.pendingRolePurchases.length, 0)
  assert.equal(db.stripeConstructs.length, 0)
  assert.equal(db.roles.length, 1)
  assert.equal(db.roles[0].id, response.body.role_id)
  assert.equal(db.roles[0].client_id, 'parent-client')
  assert.equal(db.rpcCalls[0].name, 'claim_first_role_prepay_credit')
  assert.equal(db.rpcCalls[0].args.p_claim_context, 'role_checkout')
  assert.equal(db.clientRoleCredits[0].status, 'used')
  assert.equal(db.clientRoleCredits[0].used_by_role_id, response.body.role_id)
  assert.match(db.clientRoleCredits[0].used_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(db.clientRoleCredits[0].metadata.claimed_by, 'role_checkout')
  assert.equal(db.clientRoleCredits[0].metadata.consumed_by, 'role_checkout')
  assert.deepEqual(db.rubricCalls, [response.body.role_id])
})

test('role checkout under child entity consumes parent billing client credit', async () => {
  const db = makeDb({
    clientRoleCredits: [{
      id: 'credit-child',
      billing_client_id: 'parent-client',
      source_client_id: 'parent-client',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null
    }]
  })
  const response = await postRoleCheckout(buildApp(db), 'child-client')

  assert.equal(response.status, 200)
  assert.equal(response.body.credit_applied, true)
  assert.equal(db.rpcCalls[0].args.p_billing_client_id, 'parent-client')
  assert.equal(db.rpcCalls[0].args.p_source_client_id, 'child-client')
  assert.equal(db.roles[0].client_id, 'child-client')
  assert.equal(db.pendingRolePurchases.length, 0)
  assert.equal(db.stripeConstructs.length, 0)
})

test('second role after first-role credit use follows normal Stripe checkout flow', async () => {
  const db = makeDb({
    clientRoleCredits: [{
      id: 'credit-1',
      billing_client_id: 'parent-client',
      source_client_id: 'parent-client',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null
    }]
  })
  const app = buildApp(db)

  const firstResponse = await postRoleCheckout(app, 'parent-client')
  assert.equal(firstResponse.status, 200)
  assert.equal(firstResponse.body.credit_applied, true)

  const secondResponse = await postRoleCheckout(app, 'parent-client', { roleTitle: 'Treatment Coordinator' })
  assert.equal(secondResponse.status, 200)
  assert.equal(secondResponse.body.ok, true)
  assert.equal(secondResponse.body.credit_applied, undefined)
  assert.equal(secondResponse.body.session_id, 'cs_role_1')
  assert.equal(secondResponse.body.url, 'https://checkout.stripe.test/cs_role_1')
  assert.equal(db.pendingRolePurchases.length, 1)
  assert.equal(db.pendingRolePurchases[0].status, 'pending')
  assert.equal(db.pendingRolePurchases[0].role_title, 'Treatment Coordinator')
  assert.equal(db.stripeConstructs.length, 1)
  assert.equal(db.stripeCalls.pricesCreate.length, 1)
  assert.equal(db.stripeCalls.sessionsCreate.length, 1)
})

test('role checkout without credit preserves existing Stripe checkout behavior', async () => {
  const db = makeDb()
  const response = await postRoleCheckout(buildApp(db), 'parent-client')

  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.session_id, 'cs_role_1')
  assert.equal(response.body.url, 'https://checkout.stripe.test/cs_role_1')
  assert.equal(db.roles.length, 0)
  assert.equal(db.pendingRolePurchases.length, 1)
  assert.equal(db.pendingRolePurchases[0].client_id, 'parent-client')
  assert.equal(db.pendingRolePurchases[0].jd_storage_path, 'job-descriptions/pending/parent-client/pending-1/jd.pdf')
  assert.equal(db.stripeConstructs.length, 1)
  assert.equal(db.stripeCalls.customersRetrieve[0], 'cus_existing')
  assert.equal(db.stripeCalls.pricesCreate[0].unit_amount, 39900)
})

test('credit race fallback does not both consume credit and create a Stripe role checkout', async () => {
  const db = makeDb({
    rpcMode: 'race',
    clientRoleCredits: [{
      id: 'credit-race',
      billing_client_id: 'parent-client',
      source_client_id: 'parent-client',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null
    }]
  })
  const originalWarn = console.warn
  console.warn = () => {}
  let response
  try {
    response = await postRoleCheckout(buildApp(db), 'parent-client')
  } finally {
    console.warn = originalWarn
  }

  assert.equal(response.status, 200)
  assert.equal(response.body.session_id, 'cs_role_1')
  assert.equal(db.clientRoleCredits[0].status, 'unused')
  assert.equal(db.clientRoleCredits[0].used_at, null)
  assert.equal(db.clientRoleCredits[0].used_by_role_id, null)
  assert.equal(db.roles.length, 0)
  assert.equal(db.pendingRolePurchases.length, 1)
  assert.equal(db.stripeConstructs.length, 1)
})

test('prepaid role creation failure leaves credit unused and does not open Stripe checkout', async () => {
  const db = makeDb({
    roleInsertError: 'roles insert failed',
    clientRoleCredits: [{
      id: 'credit-error',
      billing_client_id: 'parent-client',
      source_client_id: 'parent-client',
      credit_type: 'first_role_prepay',
      status: 'unused',
      used_at: null,
      used_by_role_id: null
    }]
  })
  const response = await postRoleCheckout(buildApp(db), 'parent-client')

  assert.equal(response.status, 500)
  assert.equal(response.body.error, 'create_role_checkout_session_failed')
  assert.equal(db.clientRoleCredits[0].status, 'unused')
  assert.equal(db.clientRoleCredits[0].used_at, null)
  assert.equal(db.clientRoleCredits[0].used_by_role_id, null)
  assert.equal(db.clientRoleCredits[0].metadata.released_by, 'role_checkout')
  assert.equal(db.roles.length, 0)
  assert.equal(db.pendingRolePurchases.length, 0)
  assert.equal(db.stripeConstructs.length, 0)
})

'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const projectRoot = path.resolve(__dirname, '..')
const { test } = require('node:test')

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'alphascreen', 'index.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
const rateLimitPath = path.join(__dirname, '..', 'src', 'lib', 'rateLimit.js')
const STALE_ANNUAL_PRICE_PATTERN = new RegExp([
  String(3229 + 0.2).replace('.', '\\.'),
  String(322900 + 20),
  String(6469 + 0.2).replace('.', '\\.'),
  String(646900 + 20)
].join('|'))
const STALE_DISCOUNT_KEY = ['annual', 'discount_percent'].join('_')

function assertNoStaleAnnualPricingPayload(value) {
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized, STALE_ANNUAL_PRICE_PATTERN)
  assert.equal(Object.prototype.hasOwnProperty.call(value || {}, STALE_DISCOUNT_KEY), false)
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.inFilters = []
    this.gteFilters = []
    this.orderBy = null
    this.limitCount = null
    this.insertPayload = null
    this.updatePayload = null
  }

  select(columns) {
    this.selectColumns = columns
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value })
    return this
  }

  in(column, values) {
    this.inFilters.push({ column, values: new Set((values || []).map(String)) })
    return this
  }

  gte(column, value) {
    this.gteFilters.push({ column, value })
    return this
  }

  order(column, options = {}) {
    this.orderBy = { column, ascending: options.ascending === true }
    return this
  }

  limit(count) {
    this.limitCount = Number(count)
    return this
  }

  insert(payload) {
    this.insertPayload = payload
    return this
  }

  update(payload) {
    this.updatePayload = payload
    return this
  }

  rowsForTable() {
    if (this.table === 'public_purchase_intents') {
      if (Array.isArray(this.db.purchaseIntents)) return this.db.purchaseIntents
      return this.db.existingIntent ? [this.db.existingIntent] : []
    }
    if (this.table === 'client_members') return this.db.clientMembers || []
    if (this.table === 'clients') return this.db.clients || []
    if (this.table === 'membership_agreements') return this.db.membershipAgreements || []
    return []
  }

  rowMatches(row) {
    for (const { column, value } of this.filters) {
      if (row?.[column] !== value && String(row?.[column]) !== String(value)) return false
    }
    for (const { column, values } of this.inFilters) {
      if (!values.has(String(row?.[column]))) return false
    }
    for (const { column, value } of this.gteFilters) {
      const rowValue = row?.[column]
      if (rowValue === undefined || rowValue === null || String(rowValue) < String(value)) return false
    }
    return true
  }

  runSelect() {
    let rows = this.rowsForTable().filter((row) => this.rowMatches(row))
    if (this.orderBy?.column) {
      const { column, ascending } = this.orderBy
      rows = rows.slice().sort((a, b) => {
        const av = String(a?.[column] || '')
        const bv = String(b?.[column] || '')
        if (av === bv) return 0
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    if (Number.isFinite(this.limitCount)) rows = rows.slice(0, this.limitCount)
    return rows
  }

  async maybeSingle() {
    if (this.db.lookupError) return { data: null, error: this.db.lookupError }
    const existing = this.runSelect()[0] || null
    if (existing && this.updatePayload) {
      Object.assign(existing, this.updatePayload)
      this.db.updates.push({ table: this.table, row: existing, payload: this.updatePayload })
    }
    return { data: existing, error: null }
  }

  async single() {
    if (this.db.insertError) return { data: null, error: this.db.insertError }
    const row = {
      id: this.db.nextId || 'intent-1',
      ...this.insertPayload
    }
    this.db.inserts.push({ table: this.table, row })
    return { data: row, error: null }
  }
}

function makeDb(options = {}) {
  const db = {
    nextId: options.nextId || 'intent-1',
    existingIntent: options.existingIntent || null,
    purchaseIntents: options.purchaseIntents || null,
    clientMembers: options.clientMembers || [],
    clients: options.clients || [],
    membershipAgreements: options.membershipAgreements || [],
    lookupError: options.lookupError || null,
    insertError: options.insertError || null,
    inserts: [],
    updates: [],
    touchedTables: [],
    from(table) {
      db.touchedTables.push(table)
      return new FakeQuery(db, table)
    }
  }
  return db
}

function buildApp(db, env = {}) {
  // The router is assembled from several files that each cache the modules stubbed
  // below, so every first-party module reloads on each build.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(projectRoot) && !cached.includes('node_modules')) {
      delete require.cache[cached]
    }
  }
  delete require.cache[routePath]
  delete require.cache[supabaseClientPath]
  delete require.cache[rateLimitPath]
  const previous = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  injectModule(supabaseClientPath, { supabaseAdmin: db })
  const rateLimitCounts = new Map()
  injectModule(rateLimitPath, {
    getRequestSubjectKey: () => '198.51.100.20',
    hashRateLimitSubject: (...parts) => `hash:${parts.join(':')}`,
    async checkAndIncrementRateLimit({ routeName, subjectKey, maxCount }) {
      const key = `${routeName}:${subjectKey}`
      const count = (rateLimitCounts.get(key) || 0) + 1
      rateLimitCounts.set(key, count)
      return {
        allowed: count <= maxCount,
        retryAfterSeconds: count <= maxCount ? 0 : 60
      }
    }
  })
  const router = require(routePath)
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const app = express()
  app.use(express.json())
  app.use('/api/alphascreen', router)
  return app
}

async function request(app, body, headers = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/alphascreen/purchase-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
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

function validBody(overrides = {}) {
  return {
    plan_key: 'basic',
    billing_cadence: 'monthly',
    company_legal_name: 'Acme Dental Group',
    company_dba: 'Acme Dental',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: 'alex@acmedental.example',
    buyer_phone: '+1 (555) 123-4567',
    buyer_title: 'Director of Operations',
    source_path: '/alphascreen/pricing?utm_source=test',
    agreement_acknowledged: true,
    contact_acknowledged: true,
    raw_payload: { must: 'not store' },
    anonymous_id: 'anon-secret',
    session_id: 'session-secret',
    ...overrides
  }
}

function assertSignupAlreadyExistsResponse(response, expectedNextStep = 'check_email_or_contact_support') {
  const message = 'This email is already associated with an alphaScreen account or signup. Sign in, check your email, or contact support for help.'
  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'SIGNUP_ALREADY_EXISTS')
  assert.equal(response.body.error, 'signup_already_exists')
  assert.equal(response.body.detail, message)
  assert.equal(response.body.message, message)
  assert.equal(response.body.next_step, expectedNextStep)
}

test('valid Essential monthly intent creates pending intent with central package snapshot', async () => {
  const db = makeDb({ nextId: 'intent-basic' })
  const response = await request(buildApp(db), validBody())

  assert.equal(response.status, 201)
  assert.equal(response.body.purchase_intent_id, 'intent-basic')
  assert.equal(response.body.status, 'pending')
  assert.equal(response.body.selected_package.plan_key, 'basic')
  assert.equal(response.body.selected_package.billing_cadence, 'monthly')
  assert.equal(response.body.selected_package.platform_fee, 299)
  assert.equal(response.body.selected_package.platform_fee_cents, 29900)
  assert.equal(response.body.selected_package.platform_monthly_fee, 299)
  assert.equal(response.body.selected_package.platform_annual_fee, 3299)
  assert.equal(response.body.selected_package.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(response.body.selected_package.included_interviews, 20)
  assert.equal(response.body.selected_package.interview_duration_minutes, 10)
  assert.equal(response.body.selected_package.additional_interview_price, 30)
  assert.equal(response.body.selected_package.per_role_fee, 399)
  assert.equal(response.body.selected_package.first_role_prepay.selected, false)
  assert.equal(response.body.selected_package.first_role_prepay.discounted_credit_amount_cents, 35900)

  assert.equal(db.inserts.length, 1)
  const row = db.inserts[0].row
  assert.equal(row.selected_plan_key, 'basic')
  assert.equal(row.selected_billing_cadence, 'monthly')
  assert.equal(row.status, 'pending')
  assert.equal(row.source_path, '/alphascreen/pricing')
  assert.equal(row.agreement_id, null)
  assert.equal(row.stripe_checkout_session_id, null)
  assert.equal(row.client_id, null)
  assert.equal(row.first_role_prepay_selected, false)
  assert.equal(row.first_role_prepay_amount_cents, null)
  assert.equal(row.first_role_normal_role_fee_cents, null)
  assert.equal(row.package_snapshot.included_interviews, 20)
  assert.equal(row.package_snapshot.platform_fee, 299)
  assert.equal(row.package_snapshot.platform_fee_cents, 29900)
  assert.equal(row.package_snapshot.platform_fee_billing_cadence, 'monthly')
  assert.equal(row.package_snapshot.platform_monthly_fee, 299)
  assert.equal(row.package_snapshot.platform_annual_fee, 3299)
  assert.equal(row.package_snapshot.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(row.package_snapshot.per_role_fee, 399)
  assert.equal(row.package_snapshot.first_role_prepay.selected, false)
  assert.equal(row.package_snapshot.first_role_prepay.normal_role_fee_cents, 39900)
  assert.equal(row.package_snapshot.first_role_prepay.discounted_credit_amount_cents, 35900)
  assertNoStaleAnnualPricingPayload(response.body.selected_package)
  assertNoStaleAnnualPricingPayload(row.package_snapshot)
})

test('valid Pro annual intent creates pending intent when annual cadence is supported', async () => {
  const db = makeDb({ nextId: 'intent-pro' })
  const response = await request(buildApp(db), validBody({
    plan_key: 'pro',
    billing_cadence: 'annual',
    buyer_email: 'buyer@company.example'
  }))

  assert.equal(response.status, 201)
  assert.equal(response.body.selected_package.plan_key, 'pro')
  assert.equal(response.body.selected_package.billing_cadence, 'annual')
  assert.equal(response.body.selected_package.platform_fee, 6499)
  assert.equal(response.body.selected_package.platform_fee_cents, 649900)
  assert.equal(response.body.selected_package.platform_monthly_fee, 599)
  assert.equal(response.body.selected_package.platform_annual_fee, 6499)
  assert.equal(response.body.selected_package.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(response.body.selected_package.included_interviews, 30)
  assert.equal(response.body.selected_package.max_interview_minutes, 12)
  assert.equal(response.body.selected_package.additional_interview_fee, 35)
  assert.equal(response.body.selected_package.first_role_prepay.selected, false)
  assert.equal(response.body.selected_package.first_role_prepay.discounted_credit_amount_cents, 62900)
  assert.equal(db.inserts[0].row.package_snapshot.per_role_fee, 699)
  assert.equal(db.inserts[0].row.package_snapshot.platform_fee, 6499)
  assert.equal(db.inserts[0].row.package_snapshot.platform_fee_cents, 649900)
  assert.equal(db.inserts[0].row.package_snapshot.platform_fee_billing_cadence, 'annual')
  assertNoStaleAnnualPricingPayload(response.body.selected_package)
  assertNoStaleAnnualPricingPayload(db.inserts[0].row.package_snapshot)
})

test('purchase intent with selected first-role prepay snapshots immutable Essential credit values', async () => {
  const db = makeDb({ nextId: 'intent-basic-prepay' })
  const response = await request(buildApp(db), validBody({
    first_role_prepay_selected: true
  }))

  assert.equal(response.status, 201)
  assert.equal(response.body.selected_package.first_role_prepay.selected, true)
  assert.equal(response.body.selected_package.first_role_prepay.credit_type, 'first_role_prepay')
  assert.equal(response.body.selected_package.first_role_prepay.normal_role_fee_cents, 39900)
  assert.equal(response.body.selected_package.first_role_prepay.discounted_credit_amount_cents, 35900)
  assert.equal(response.body.selected_package.first_role_prepay.discount_percent, 10)
  assert.equal(response.body.selected_package.first_role_prepay.non_refundable, true)
  assert.equal(response.body.selected_package.first_role_prepay.expires, false)

  const row = db.inserts[0].row
  assert.equal(row.first_role_prepay_selected, true)
  assert.equal(row.first_role_prepay_amount_cents, 35900)
  assert.equal(row.first_role_normal_role_fee_cents, 39900)
  assert.equal(row.first_role_prepay_discount_percent, 10)
  assert.equal(row.first_role_prepay_credit_type, 'first_role_prepay')
  assert.deepEqual(row.package_snapshot.first_role_prepay, {
    enabled: true,
    credit_type: 'first_role_prepay',
    normal_role_fee_cents: 39900,
    discounted_credit_amount_cents: 35900,
    discount_percent: 10,
    non_refundable: true,
    expires: false,
    selected: true
  })
})

test('purchase intent accepts nested selected first-role prepay for Pro and malformed input falls back to pay-later', async () => {
  const proDb = makeDb({ nextId: 'intent-pro-prepay' })
  const proResponse = await request(buildApp(proDb), validBody({
    plan_key: 'pro',
    billing_cadence: 'annual',
    buyer_email: 'pro-prepay@company.example',
    first_role_prepay: { selected: true }
  }))

  assert.equal(proResponse.status, 201)
  assert.equal(proDb.inserts[0].row.first_role_prepay_selected, true)
  assert.equal(proDb.inserts[0].row.first_role_prepay_amount_cents, 62900)
  assert.equal(proDb.inserts[0].row.first_role_normal_role_fee_cents, 69900)

  const malformedDb = makeDb({ nextId: 'intent-malformed-prepay' })
  const malformedResponse = await request(buildApp(malformedDb), validBody({
    buyer_email: 'malformed-prepay@company.example',
    first_role_prepay: 'yes please'
  }))

  assert.equal(malformedResponse.status, 201)
  assert.equal(malformedDb.inserts[0].row.first_role_prepay_selected, false)
  assert.equal(malformedDb.inserts[0].row.package_snapshot.first_role_prepay.selected, false)
})

test('purchase intent accepts personal email domains and normalizes email', async () => {
  const cases = [
    ['igrunner@icloud.com', 'igrunner@icloud.com'],
    ['Buyer.Person+test@Gmail.com', 'buyer.person+test@gmail.com'],
    ['owner@yahoo.com', 'owner@yahoo.com'],
    ['founder@outlook.com', 'founder@outlook.com']
  ]

  for (const [inputEmail, storedEmail] of cases) {
    const db = makeDb()
    const response = await request(buildApp(db), validBody({ buyer_email: inputEmail }))

    assert.equal(response.status, 201)
    assert.equal(db.inserts.length, 1)
    assert.equal(db.inserts[0].row.buyer_email, storedEmail)
  }
})

test('invalid purchase intent inputs are rejected before insert', async () => {
  const cases = [
    [{ plan_key: 'enterprise' }, 'invalid_plan'],
    [{ billing_cadence: 'weekly' }, 'invalid_billing_cadence'],
    [{ buyer_email: 'not-an-email' }, 'invalid_email'],
    [{ company_legal_name: '' }, 'required_fields_missing']
  ]

  for (const [override, code] of cases) {
    const db = makeDb()
    const response = await request(buildApp(db), validBody(override))
    assert.equal(response.status, 400)
    assert.equal(response.body.code, code)
    assert.equal(db.inserts.length, 0)
  }
})

test('purchase intent requires buyer phone before insert', async () => {
  for (const value of ['', '   ', 'letters only']) {
    const db = makeDb()
    const response = await request(buildApp(db), validBody({ buyer_phone: value }))

    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'required_fields_missing')
    assert.equal(response.body.fields.includes('buyer_phone'), true)
    assert.equal(db.inserts.length, 0)
  }
})

test('purchase intent requires buyer title before insert', async () => {
  const db = makeDb()
  const response = await request(buildApp(db), validBody({ buyer_title: '   ' }))

  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'required_fields_missing')
  assert.equal(response.body.fields.includes('buyer_title'), true)
  assert.equal(db.inserts.length, 0)
})

test('long strings are bounded before storage', async () => {
  const db = makeDb()
  const response = await request(buildApp(db), validBody({
    company_legal_name: 'C'.repeat(260),
    company_dba: 'D'.repeat(260),
    buyer_first_name: 'F'.repeat(140),
    buyer_last_name: 'L'.repeat(140),
    buyer_title: 'T'.repeat(180),
    buyer_phone: '+1 (555) 123-4567 ext raw text that should be bounded'
  }))

  assert.equal(response.status, 201)
  const row = db.inserts[0].row
  assert.equal(row.company_legal_name.length, 160)
  assert.equal(row.company_dba.length, 160)
  assert.equal(row.buyer_first_name.length, 80)
  assert.equal(row.buyer_last_name.length, 80)
  assert.equal(row.buyer_title.length, 120)
  assert.ok(row.buyer_phone.length <= 40)
})

test('purchase intent endpoint stores and returns no raw payload, session, IP, user-agent, client, user, agreement, or Stripe records', async () => {
  const db = makeDb()
  const response = await request(buildApp(db), validBody(), {
    'x-forwarded-for': '203.0.113.10',
    'user-agent': 'raw-test-agent'
  })

  assert.equal(response.status, 201)
  assert.deepEqual(Array.from(new Set(db.inserts.map((entry) => entry.table))), ['public_purchase_intents'])
  assert.equal(db.inserts[0].row.client_id, null)
  assert.equal(db.inserts[0].row.agreement_id, null)
  assert.equal(db.inserts[0].row.stripe_checkout_session_id, null)
  const serializedRow = JSON.stringify(db.inserts[0].row)
  const serializedResponse = JSON.stringify(response.body)
  assert.doesNotMatch(serializedRow, /raw_payload|anon-secret|session-secret|203\.0\.113\.10|raw-test-agent|client_members|membership_agreements|stripe_customer|stripe_subscription/i)
  assert.doesNotMatch(serializedResponse, /raw_payload|anon-secret|session-secret|203\.0\.113\.10|raw-test-agent|buyer_email|company_legal_name/i)
})

test('duplicate pending intent returns existing safe response without inserting', async () => {
  const db = makeDb({
    existingIntent: {
      id: 'existing-intent',
      status: 'pending',
      selected_plan_key: 'basic',
      selected_billing_cadence: 'monthly',
      buyer_email: 'alex@acmedental.example',
      company_legal_name: 'Acme Dental Group',
      buyer_phone: '+1 (555) 000-0001',
      first_role_prepay_selected: false,
      created_at: new Date().toISOString(),
      package_snapshot: {
        plan_key: 'basic',
        display_name: 'Essential',
        billing_cadence: 'monthly',
        platform_fee: 299,
        platform_fee_cents: 29900,
        platform_fee_billing_cadence: 'monthly',
        platform_monthly_fee: 299,
        platform_monthly_fee_cents: 29900,
        platform_annual_fee: 3299,
        platform_annual_fee_cents: 329900,
        annual_platform_fee_note: 'Discounted annual platform fee',
        included_interviews: 20,
        included_interviews_per_role: 20,
        interview_duration_minutes: 10,
        max_interview_minutes: 10,
        additional_interview_price: 30,
        additional_interview_fee: 30,
        overage_price: 30,
        per_role_fee: 399
      }
    }
  })
  const response = await request(buildApp(db), validBody())

  assert.equal(response.status, 200)
  assert.equal(response.body.purchase_intent_id, 'existing-intent')
  assert.equal(response.body.duplicate, true)
  assert.equal(db.inserts.length, 0)
  assert.equal(db.updates.length, 1)
  assert.equal(db.updates[0].payload.buyer_phone, '+1 (555) 123-4567')
  assert.equal(db.existingIntent.buyer_phone, '+1 (555) 123-4567')
})

test('active client member email is blocked from creating a new retail signup', async () => {
  const db = makeDb({
    clientMembers: [{
      client_id: 'client-active',
      email: 'alex@acmedental.example',
      role: 'manager',
      user_id: 'user-existing'
    }],
    clients: [{
      id: 'client-active',
      archived_at: null,
      billing_status: 'active'
    }]
  })

  const response = await request(buildApp(db), validBody())

  assertSignupAlreadyExistsResponse(response, 'sign_in_or_contact_support')
  assert.equal(db.inserts.length, 0)
})

test('pending public purchase email is blocked instead of creating duplicate signup state', async () => {
  const db = makeDb({
    purchaseIntents: [{
      id: 'intent-in-progress',
      buyer_email: 'alex@acmedental.example',
      company_legal_name: 'Different Dental Group',
      selected_plan_key: 'pro',
      selected_billing_cadence: 'annual',
      first_role_prepay_selected: true,
      status: 'agreement_pending',
      created_at: '2026-06-27T12:00:00.000Z'
    }]
  })

  const response = await request(buildApp(db), validBody())

  assertSignupAlreadyExistsResponse(response)
  assert.equal(db.inserts.length, 0)
})

test('paid setup-pending public purchase email is blocked from duplicate signup state', async () => {
  const db = makeDb({
    purchaseIntents: [{
      id: 'intent-paid',
      buyer_email: 'alex@acmedental.example',
      status: 'completed',
      client_id: 'client-paid',
      agreement_id: 'agreement-paid',
      created_at: '2026-06-27T12:00:00.000Z'
    }]
  })

  const response = await request(buildApp(db), validBody())

  assertSignupAlreadyExistsResponse(response)
  assert.equal(db.inserts.length, 0)
})

test('existing membership agreement email is blocked before creating a duplicate purchase intent', async () => {
  const db = makeDb({
    membershipAgreements: [{
      id: 'agreement-existing',
      admin_email: 'alex@acmedental.example',
      status: 'signed',
      checkout_status: 'paid',
      client_id: 'client-paid',
      created_at: '2026-06-27T12:00:00.000Z'
    }]
  })

  const response = await request(buildApp(db), validBody())

  assertSignupAlreadyExistsResponse(response)
  assert.equal(db.inserts.length, 0)
})

test('purchase intent endpoint rate limits repeated requests', async () => {
  const db = makeDb()
  const app = buildApp(db, { ALPHASCREEN_PURCHASE_INTENT_RATE_MAX: '1' })

  const first = await request(app, validBody({ buyer_email: 'one@company.example' }), { 'x-forwarded-for': '198.51.100.20' })
  const differentCustomer = await request(app, validBody({ buyer_email: 'two@company.example' }), { 'x-forwarded-for': '198.51.100.20' })
  const second = await request(app, validBody({ buyer_email: 'one@company.example' }), { 'x-forwarded-for': '198.51.100.20' })

  assert.equal(first.status, 201)
  assert.equal(differentCustomer.status, 201)
  assert.equal(second.status, 429)
  assert.equal(second.body.code, 'RETAIL_SIGNUP_RATE_LIMITED')
  assert.equal(second.body.retry_after_seconds, 60)
})

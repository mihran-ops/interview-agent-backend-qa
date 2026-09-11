'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const projectRoot = path.resolve(__dirname, '..')
const { test } = require('node:test')

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'membershipAgreements', 'index.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
const clientBillingScopePath = path.join(__dirname, '..', 'src', 'lib', 'clientBillingScope.js')
const subscriptionCheckoutPath = path.join(__dirname, '..', 'src', 'lib', 'subscriptionCheckout.js')
const pdfRendererPath = path.join(__dirname, '..', 'utils', 'pdfRenderer.js')
const mailerPath = path.join(__dirname, '..', 'utils', 'mailer.js')
const urlConfigPath = path.join(__dirname, '..', 'config', 'urlConfig.js')

const TOKEN = 'phase-c3-test-token'
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex')
const AGREEMENT_ID = '33333333-3333-4333-8333-333333333333'
const INTENT_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_ID = '44444444-4444-4444-8444-444444444444'

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

function matchesFilters(row, filters) {
  return filters.every(({ column, value }) => String(row?.[column] ?? '') === String(value ?? ''))
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
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

  in() {
    return this
  }

  order() {
    return this
  }

  limit() {
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

  tableRows() {
    if (this.table === 'membership_agreements') return this.db.membershipAgreements
    if (this.table === 'public_purchase_intents') return this.db.purchaseIntents
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'client_members') return this.db.clientMembers
    return []
  }

  async maybeSingle() {
    const row = this.tableRows().find((item) => matchesFilters(item, this.filters)) || null
    return { data: row, error: null }
  }

  async single() {
    if (this.db.insertError && this.insertPayload) return { data: null, error: this.db.insertError }
    if (this.db.updateError && this.updatePayload) return { data: null, error: this.db.updateError }
    if (this.insertPayload) {
      const row = { ...this.insertPayload }
      if (this.table === 'clients' && !row.id) row.id = this.db.nextClientId || CLIENT_ID
      this.tableRows().push(row)
      this.db.inserts.push({ table: this.table, row })
      return { data: row, error: null }
    }
    if (this.updatePayload) {
      const rows = this.tableRows().filter((item) => matchesFilters(item, this.filters))
      const row = rows[0] || null
      if (!row) return { data: null, error: { message: 'row_not_found', code: 'PGRST116' } }
      for (const item of rows) Object.assign(item, this.updatePayload)
      this.db.updates.push({ table: this.table, rows, payload: this.updatePayload })
      return { data: row, error: null }
    }
    return this.maybeSingle()
  }

  async execute() {
    if (this.updatePayload) {
      const rows = this.tableRows().filter((item) => matchesFilters(item, this.filters))
      for (const item of rows) Object.assign(item, this.updatePayload)
      this.db.updates.push({ table: this.table, rows, payload: this.updatePayload })
      return { data: null, error: null }
    }
    if (this.insertPayload) {
      return this.single()
    }
    return this.maybeSingle()
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeSnapshot(plan, cadence, firstRolePrepaySelected = false) {
  const basic = plan === 'basic'
  const annual = cadence === 'annual'
  return {
    plan_key: plan,
    display_name: basic ? 'Essential' : 'Pro',
    billing_cadence: cadence,
    platform_fee: basic ? (annual ? 3299 : 299) : (annual ? 6499 : 599),
    platform_fee_billing_cadence: cadence,
    platform_monthly_fee: basic ? 299 : 599,
    platform_annual_fee: basic ? 3299 : 6499,
    included_interviews: basic ? 20 : 30,
    included_interviews_per_role: basic ? 20 : 30,
    interview_duration_minutes: basic ? 10 : 12,
    max_interview_minutes: basic ? 10 : 12,
    additional_interview_price: basic ? 30 : 35,
    additional_interview_fee: basic ? 30 : 35,
    overage_price: basic ? 30 : 35,
    per_role_fee: basic ? 399 : 699,
    first_role_prepay: {
      enabled: true,
      credit_type: 'first_role_prepay',
      normal_role_fee_cents: basic ? 39900 : 69900,
      discounted_credit_amount_cents: basic ? 35900 : 62900,
      discount_percent: 10,
      non_refundable: true,
      expires: false,
      selected: firstRolePrepaySelected === true
    }
  }
}

function agreement(overrides = {}) {
  const plan = overrides.plan || 'basic'
  const cadence = overrides.cadence || 'monthly'
  const snapshot = Object.prototype.hasOwnProperty.call(overrides, 'packageSnapshot')
    ? overrides.packageSnapshot
    : makeSnapshot(plan, cadence, overrides.firstRolePrepaySelected)
  const values = snapshot
    ? {
        client_id: null,
        client_legal_name: 'Acme Dental Group',
        dba_trade_name: 'Acme Dental',
        primary_admin_name: 'Alex Rivera',
        admin_email: 'alex@acmedental.example',
        membership_tier: plan,
        platform_fee: String(snapshot.platform_fee),
        per_role_fee: String(snapshot.per_role_fee),
        additional_interview_fee: String(snapshot.additional_interview_fee),
        included_interviews_per_role: String(snapshot.included_interviews_per_role),
        max_interview_minutes: String(snapshot.max_interview_minutes),
        initial_term_start: '2026-06-23',
        initial_renewal_date: '2027-06-23',
        billing_option: cadence,
        auto_renew: true,
        notice_deadline_days: 30
      }
    : {
        membership_tier: plan,
        billing_option: cadence
      }

  return {
    id: AGREEMENT_ID,
    client_id: overrides.client_id || null,
    status: overrides.status || 'signed',
    is_current: overrides.is_current !== false,
    checkout_status: overrides.checkout_status || null,
    signer_token_hash: TOKEN_HASH,
    client_legal_name: 'Acme Dental Group',
    dba_trade_name: 'Acme Dental',
    primary_admin_name: 'Alex Rivera',
    admin_email: 'alex@acmedental.example',
    membership_tier: plan,
    initial_term_start: '2026-06-23',
    initial_renewal_date: '2027-06-23',
    billing_option: cadence,
    auto_renew: true,
    notice_deadline_days: 30,
    template_snapshot: {
      source: 'public_purchase_intent',
      purchase_intent: { id: INTENT_ID },
      package_snapshot: snapshot,
      values
    },
    draft_pdf_path: 'membership-agreements/draft.pdf',
    executed_pdf_path: 'membership-agreements/executed.pdf',
    signer_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    opened_at: null,
    sent_at: new Date().toISOString(),
    signed_at: new Date().toISOString(),
    signer_typed_name: 'Alex Rivera'
  }
}

function intent(overrides = {}) {
  const plan = overrides.plan || 'basic'
  const cadence = overrides.cadence || 'monthly'
  return {
    id: INTENT_ID,
    status: overrides.status || 'agreement_pending',
    selected_plan_key: plan,
    selected_billing_cadence: cadence,
    package_snapshot: overrides.package_snapshot || makeSnapshot(plan, cadence, overrides.firstRolePrepaySelected),
    first_role_prepay_selected: overrides.firstRolePrepaySelected === true,
    first_role_prepay_amount_cents: overrides.firstRolePrepaySelected === true ? (plan === 'basic' ? 35900 : 62900) : null,
    first_role_normal_role_fee_cents: overrides.firstRolePrepaySelected === true ? (plan === 'basic' ? 39900 : 69900) : null,
    first_role_prepay_discount_percent: overrides.firstRolePrepaySelected === true ? 10 : null,
    first_role_prepay_credit_type: overrides.firstRolePrepaySelected === true ? 'first_role_prepay' : null,
    company_legal_name: 'Acme Dental Group',
    company_dba: 'Acme Dental',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: 'alex@acmedental.example',
    buyer_phone: '+1 555 1212',
    buyer_title: 'Director',
    source_path: '/alphascreen/pricing',
    agreement_id: AGREEMENT_ID,
    stripe_checkout_session_id: null,
    client_id: overrides.client_id || null,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString()
  }
}

function makeDb(options = {}) {
  const db = {
    membershipAgreements: options.membershipAgreements || [],
    purchaseIntents: options.purchaseIntents || [],
    clients: options.clients || [],
    clientMembers: [],
    inserts: [],
    updates: [],
    touchedTables: [],
    checkoutCalls: [],
    nextClientId: options.nextClientId || CLIENT_ID,
    from(table) {
      this.touchedTables.push(table)
      return new FakeQuery(this, table)
    },
    storage: {
      from() {
        return {
          createSignedUrl: async () => ({ data: { signedUrl: 'https://qa.example/agreement.pdf' }, error: null })
        }
      }
    }
  }
  return db
}

function buildApp(db) {
  // The router is assembled from several files that each cache the modules stubbed
  // below, so every first-party module reloads on each build.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(projectRoot) && !cached.includes('node_modules')) {
      delete require.cache[cached]
    }
  }
  for (const filename of [
    routePath,
    supabaseClientPath,
    clientBillingScopePath,
    subscriptionCheckoutPath,
    pdfRendererPath,
    mailerPath,
    urlConfigPath
  ]) {
    delete require.cache[filename]
  }

  injectModule(supabaseClientPath, { supabaseAdmin: db })
  injectModule(clientBillingScopePath, {
    requireParentClient: async (_db, clientId) => {
      const client = db.clients.find((row) => String(row.id) === String(clientId))
      if (!client) {
        return { ok: false, status: 404, body: { error: 'CLIENT_NOT_FOUND', code: 'CLIENT_NOT_FOUND', detail: 'Client not found.' } }
      }
      if (client.parent_client_id) {
        return { ok: false, status: 400, body: { error: 'CHILD_CLIENT_NOT_ALLOWED', code: 'CHILD_CLIENT_NOT_ALLOWED', detail: 'Child client not allowed.' } }
      }
      return { ok: true, client, clientId: client.id }
    }
  })
  injectModule(subscriptionCheckoutPath, {
    createSubscriptionCheckoutSession: async (args) => {
      db.checkoutCalls.push(args)
      const sessionId = `cs_test_${String(args.planTier)}_${String(args.billingInterval)}`
      return {
        session: { id: sessionId, url: `https://checkout.stripe.test/${sessionId}` },
        fallbackSession: null,
        checkoutClientSecret: '',
        replacesStripeSubscriptionId: null,
        replacementPolicy: null
      }
    }
  })
  injectModule(pdfRendererPath, { htmlToPdf: async () => Buffer.from('%PDF') })
  injectModule(mailerPath, {
    sendMembershipAgreementSignedCopyEmail: async () => {},
    sendMembershipAgreementCompletedInternalNotification: async () => {}
  })
  injectModule(urlConfigPath, {
    buildMembershipAgreementSignUrl(token) {
      return `https://qa.alphasourceai.com/membership-agreement/sign/${encodeURIComponent(token)}`
    }
  })

  const router = require(routePath)
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use('/membership-agreements', router)
  return app
}

async function postCheckout(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/membership-agreements/checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, embedded: false })
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

test('signed public purchase agreements create hosted checkout for Essential/Pro monthly and annual packages', async () => {
  const cases = [
    ['basic', 'monthly', 299, 399, 20, 10, 30],
    ['basic', 'annual', 3299, 399, 20, 10, 30],
    ['pro', 'monthly', 599, 699, 30, 12, 35],
    ['pro', 'annual', 6499, 699, 30, 12, 35]
  ]

  for (const [plan, cadence, platformFee, perRoleFee, included, minutes, overage] of cases) {
    const db = makeDb({
      membershipAgreements: [agreement({ plan, cadence })],
      purchaseIntents: [intent({ plan, cadence })]
    })
    const response = await postCheckout(buildApp(db))

    assert.equal(response.status, 200)
    assert.match(response.body.url, /^https:\/\/checkout\.stripe\.test\/cs_test_/)
    assert.equal(response.body.checkout_client_secret, null)
    assert.equal(db.checkoutCalls.length, 1)

    const call = db.checkoutCalls[0]
    assert.equal(call.clientId, CLIENT_ID)
    assert.equal(call.planTier, plan)
    assert.equal(call.billingInterval, cadence)
    assert.equal(call.metadataSource, 'agreement_checkout')
    assert.equal(call.embedded, false)
    assert.match(call.cancelUrl, /checkout=cancel/)
    assert.match(call.idempotencyKey, new RegExp(`agreement_checkout:${AGREEMENT_ID}:${plan}:${cadence}`))
    assert.deepEqual(call.enterpriseFees, null)
    assert.equal(call.firstRolePrepay, null)
    assert.equal(call.metadata.agreement_id, AGREEMENT_ID)
    assert.equal(call.metadata.purchase_intent_id, INTENT_ID)
    assert.equal(call.metadata.package_plan_key, plan)
    assert.equal(call.metadata.package_billing_cadence, cadence)
    assert.equal(call.metadata.platform_fee, platformFee)
    assert.equal(call.metadata.per_role_fee, perRoleFee)
    assert.equal(call.metadata.included_interviews_per_role, included)
    assert.equal(call.metadata.max_interview_minutes, minutes)
    assert.equal(call.metadata.additional_interview_fee, overage)
    assert.equal(call.metadata.first_role_prepay_selected, undefined)

    const clientInsert = db.inserts.find((entry) => entry.table === 'clients')
    assert.ok(clientInsert)
    assert.equal(clientInsert.row.billing_status, 'inactive')
    assert.equal(clientInsert.row.subscription_status, 'incomplete')
    assert.equal(clientInsert.row.plan_tier, plan)
    assert.equal(clientInsert.row.billing_interval, cadence)

    const agreementCheckoutUpdate = db.updates.find((entry) => entry.table === 'membership_agreements' && entry.payload.checkout_status === 'pending_payment')
    assert.ok(agreementCheckoutUpdate)
    assert.equal(agreementCheckoutUpdate.payload.checkout_session_id, `cs_test_${plan}_${cadence}`)

    const intentCheckoutUpdate = db.updates.find((entry) => entry.table === 'public_purchase_intents' && entry.payload.status === 'checkout_pending')
    assert.ok(intentCheckoutUpdate)
    assert.equal(intentCheckoutUpdate.payload.stripe_checkout_session_id, `cs_test_${plan}_${cadence}`)
    assert.equal(intentCheckoutUpdate.payload.client_id, CLIENT_ID)

    const serialized = JSON.stringify(response.body) + JSON.stringify(call.metadata)
    assert.doesNotMatch(serialized, /sk_test|sk_live|STRIPE_PRICE|price_/i)
    assert.deepEqual(Array.from(new Set(db.touchedTables)).sort(), ['clients', 'membership_agreements', 'public_purchase_intents'])
  }
})

test('signed public purchase checkout passes first-role prepay line item metadata when selected', async () => {
  const db = makeDb({
    membershipAgreements: [agreement({ plan: 'pro', cadence: 'annual', firstRolePrepaySelected: true })],
    purchaseIntents: [intent({ plan: 'pro', cadence: 'annual', firstRolePrepaySelected: true })]
  })
  const response = await postCheckout(buildApp(db))

  assert.equal(response.status, 200)
  assert.equal(db.checkoutCalls.length, 1)
  const call = db.checkoutCalls[0]
  assert.deepEqual(call.firstRolePrepay, {
    selected: true,
    credit_type: 'first_role_prepay',
    amount_cents: 62900,
    normal_role_fee_cents: 69900,
    discount_percent: 10
  })
  assert.equal(call.metadata.first_role_prepay_selected, 'true')
  assert.equal(call.metadata.first_role_prepay_credit_type, 'first_role_prepay')
  assert.equal(call.metadata.first_role_prepay_amount_cents, 62900)
  assert.equal(call.metadata.first_role_prepay_normal_role_fee_cents, 69900)
  assert.equal(call.metadata.first_role_prepay_discount_percent, 10)
  assert.equal(call.metadata.public_purchase_intent_id, INTENT_ID)
  assert.equal(call.metadata.membership_agreement_id, AGREEMENT_ID)
})

test('unsigned public agreement cannot start checkout and creates no access records', async () => {
  const db = makeDb({
    membershipAgreements: [agreement({ status: 'sent' })],
    purchaseIntents: [intent()]
  })
  const response = await postCheckout(buildApp(db))

  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'agreement_not_checkout_eligible')
  assert.equal(db.checkoutCalls.length, 0)
  assert.equal(db.inserts.length, 0)
  assert.equal(db.updates.length, 0)
})

test('public agreement checkout rejects missing or invalid purchase-intent state before Stripe checkout', async () => {
  const missingIntentDb = makeDb({
    membershipAgreements: [agreement()],
    purchaseIntents: []
  })
  const missingIntentResponse = await postCheckout(buildApp(missingIntentDb))
  assert.equal(missingIntentResponse.status, 404)
  assert.equal(missingIntentResponse.body.code, 'purchase_intent_not_found')
  assert.equal(missingIntentDb.checkoutCalls.length, 0)

  const missingSnapshotDb = makeDb({
    membershipAgreements: [agreement({ packageSnapshot: null })],
    purchaseIntents: [intent()]
  })
  const missingSnapshotResponse = await postCheckout(buildApp(missingSnapshotDb))
  assert.equal(missingSnapshotResponse.status, 409)
  assert.equal(missingSnapshotResponse.body.code, 'package_snapshot_missing')
  assert.equal(missingSnapshotDb.checkoutCalls.length, 0)

  const completedIntentDb = makeDb({
    membershipAgreements: [agreement()],
    purchaseIntents: [intent({ status: 'completed' })]
  })
  const completedIntentResponse = await postCheckout(buildApp(completedIntentDb))
  assert.equal(completedIntentResponse.status, 409)
  assert.equal(completedIntentResponse.body.code, 'purchase_intent_not_checkout_eligible')
  assert.equal(completedIntentDb.checkoutCalls.length, 0)
})

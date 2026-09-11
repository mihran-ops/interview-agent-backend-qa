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
const pdfRendererPath = path.join(__dirname, '..', 'utils', 'pdfRenderer.js')
const urlConfigPath = path.join(__dirname, '..', 'config', 'urlConfig.js')
const publicPurchaseActivationPath = path.join(__dirname, '..', 'src', 'lib', 'publicPurchaseActivation.js')
const { buildAlphaScreenPackageSnapshot } = require('../src/lib/alphaScreenPackages')

const BASIC_INTENT_ID = '11111111-1111-4111-8111-111111111111'
const PRO_INTENT_ID = '22222222-2222-4222-8222-222222222222'
const AGREEMENT_ID = '33333333-3333-4333-8333-333333333333'

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports
  }
}

function matchesFilters(row, filters) {
  return filters.every(({ column, value }) => String(row?.[column] || '') === String(value || ''))
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

  gte() {
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
    if (this.table === 'public_purchase_intents') return this.db.purchaseIntents
    if (this.table === 'membership_agreements') return this.db.membershipAgreements
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'client_members') return this.db.clientMembers
    return []
  }

  async maybeSingle() {
    if (this.db.lookupError) return { data: null, error: this.db.lookupError }
    const row = this.tableRows().find((item) => matchesFilters(item, this.filters)) || null
    return { data: row, error: null }
  }

  async single() {
    if (this.db.insertError && this.insertPayload) return { data: null, error: this.db.insertError }
    if (this.db.updateError && this.updatePayload) return { data: null, error: this.db.updateError }

    if (this.insertPayload) {
      const row = { ...this.insertPayload }
      this.tableRows().push(row)
      this.db.inserts.push({ table: this.table, row })
      return { data: row, error: null }
    }

    if (this.updatePayload) {
      const row = this.tableRows().find((item) => matchesFilters(item, this.filters)) || null
      if (!row) return { data: null, error: { message: 'row_not_found', code: 'PGRST116' } }
      Object.assign(row, this.updatePayload)
      this.db.updates.push({ table: this.table, row, payload: this.updatePayload })
      return { data: row, error: null }
    }

    return this.maybeSingle()
  }

  async execute() {
    if (this.insertPayload || this.updatePayload) return this.single()
    return { data: this.tableRows().filter((item) => matchesFilters(item, this.filters)), error: null }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeDb(options = {}) {
  const db = {
    purchaseIntents: options.purchaseIntents || [],
    membershipAgreements: options.membershipAgreements || [],
    clients: options.clients || [],
    clientMembers: options.clientMembers || [],
    lookupError: options.lookupError || null,
    insertError: options.insertError || null,
    updateError: options.updateError || null,
    auth: {
      admin: {
        async getUserById(userId) {
          const user = (options.authUsers || []).find((item) => String(item?.id || '') === String(userId || '')) || null
          return { data: { user }, error: null }
        },
        async generateLink() {
          if (options.generateLinkError) throw options.generateLinkError
          return {
            data: {
              action_link: options.setupActionLink || 'https://qa.alphasourceai.com/pwreset?token_hash=direct-setup-token&type=recovery'
            },
            error: null
          }
        }
      }
    },
    inserts: [],
    updates: [],
    touchedTables: [],
    uploads: [],
    storage: {
      from(bucket) {
        return {
          async upload(key, body, uploadOptions) {
            db.uploads.push({ bucket, key, body, uploadOptions })
            if (options.uploadError) return { data: null, error: options.uploadError }
            return { data: { path: key }, error: null }
          }
        }
      }
    },
    from(table) {
      db.touchedTables.push(table)
      return new FakeQuery(db, table)
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
  delete require.cache[routePath]
  delete require.cache[supabaseClientPath]
  delete require.cache[rateLimitPath]
  delete require.cache[pdfRendererPath]
  delete require.cache[urlConfigPath]
  delete require.cache[publicPurchaseActivationPath]
  injectModule(supabaseClientPath, { supabaseAdmin: db })
  injectModule(rateLimitPath, {
    getRequestSubjectKey: () => '198.51.100.10',
    hashRateLimitSubject: (...parts) => `hash:${parts.join(':')}`,
    checkAndIncrementRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 })
  })
  injectModule(pdfRendererPath, { htmlToPdf: async () => Buffer.from('%PDF-qa') })
  injectModule(urlConfigPath, {
    buildMembershipAgreementSignUrl(token) {
      return `https://qa.alphasourceai.com/membership-agreement/sign/${encodeURIComponent(token)}`
    },
    buildClientPwResetUrl(query = {}) {
      const params = new URLSearchParams(query)
      const serialized = params.toString()
      return `https://qa.alphasourceai.com/pwreset${serialized ? `?${serialized}` : ''}`
    }
  })
  const router = require(routePath)
  const app = express()
  app.use(express.json())
  app.use('/api/alphascreen', router)
  return app
}

async function postAgreement(app, intentId, headers = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/alphascreen/purchase-intents/${intentId}/agreement`, {
      method: 'POST',
      headers
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

async function getCheckoutStatus(app, query = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const params = new URLSearchParams(query)
    const response = await fetch(`http://127.0.0.1:${port}/api/alphascreen/checkout-status?${params.toString()}`)
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

function intent(overrides = {}) {
  return {
    id: BASIC_INTENT_ID,
    status: 'pending',
    selected_plan_key: 'basic',
    selected_billing_cadence: 'monthly',
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
    },
    company_legal_name: 'Acme Dental Group',
    company_dba: 'Acme Dental',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: 'alex@acmedental.example',
    email_verified_at: new Date().toISOString(),
    email_verified_address: 'alex@acmedental.example',
    email_verification_method: 'retail_signup_email_otp_v1',
    email_verification_version: 1,
    buyer_phone: '+1 (555) 123-4567',
    buyer_title: 'Director of Operations',
    source_path: '/alphascreen/pricing',
    agreement_id: null,
    stripe_checkout_session_id: null,
    client_id: null,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides
  }
}

test('valid pending Essential purchase intent creates a sent agreement from purchase snapshot values', async () => {
  const db = makeDb({ purchaseIntents: [intent()] })
  const response = await postAgreement(buildApp(db), BASIC_INTENT_ID)

  assert.equal(response.status, 201)
  assert.equal(response.body.purchase_intent_id, BASIC_INTENT_ID)
  assert.equal(response.body.status, 'agreement_pending')
  assert.equal(response.body.agreement.status, 'sent')
  assert.match(response.body.agreement.signing_url, /^https:\/\/qa\.alphasourceai\.com\/membership-agreement\/sign\//)
  assert.equal(response.body.agreement.selected_package.included_interviews, 20)
  assert.equal(response.body.agreement.selected_package.max_interview_minutes, 10)
  assert.equal(response.body.agreement.selected_package.additional_interview_fee, 30)
  assert.equal(response.body.agreement.selected_package.platform_fee, 299)
  assert.equal(response.body.agreement.selected_package.platform_monthly_fee, 299)
  assert.equal(response.body.agreement.selected_package.platform_annual_fee, 3299)
  assert.equal(response.body.agreement.selected_package.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(response.body.agreement.selected_package.per_role_fee, 399)

  assert.equal(db.uploads.length, 1)
  assert.equal(db.inserts.length, 1)
  assert.equal(db.inserts[0].table, 'membership_agreements')
  const agreement = db.inserts[0].row
  assert.equal(agreement.client_id, null)
  assert.equal(agreement.status, 'sent')
  assert.equal(agreement.checkout_session_id, undefined)
  assert.equal(agreement.template_snapshot.source, 'public_purchase_intent')
  assert.equal(agreement.template_snapshot.package_snapshot.plan_key, 'basic')
  assert.equal(agreement.template_snapshot.values.membership_tier, 'basic')
  assert.equal(agreement.template_snapshot.values.billing_option, 'monthly')
  assert.equal(agreement.template_snapshot.values.platform_fee, '299')
  assert.equal(agreement.template_snapshot.values.included_interviews_per_role, '20')
  assert.equal(agreement.template_snapshot.values.max_interview_minutes, '10')
  assert.equal(agreement.template_snapshot.values.additional_interview_fee, '30')
  assert.equal(agreement.template_snapshot.values.per_role_fee, '399')
  assert.match(agreement.template_snapshot.rendered_html, /Platform Fee/)
  assert.match(agreement.template_snapshot.rendered_html, /Per-Role Fee/)
  assert.match(agreement.template_snapshot.rendered_html, /Included Interviews/)
  assert.match(agreement.template_snapshot.rendered_html, /Interview Duration Cap/)
  assert.match(agreement.template_snapshot.rendered_html, /Additional Interview Fee/)
  assert.doesNotMatch(agreement.template_snapshot.rendered_html, /first-role prepayment|did not prepay the first role/i)

  const intentUpdate = db.updates.find((update) => update.table === 'public_purchase_intents')
  assert.equal(intentUpdate.payload.status, 'agreement_pending')
  assert.equal(intentUpdate.payload.agreement_id, agreement.id)
  assert.deepEqual(Array.from(new Set(db.touchedTables)).sort(), ['membership_agreements', 'public_purchase_intents'])
})

test('public purchase agreement renders selected first-role prepay terms from snapshot', async () => {
  const snapshot = buildAlphaScreenPackageSnapshot('basic', 'monthly', { firstRolePrepaySelected: true })
  const db = makeDb({
    purchaseIntents: [intent({
      package_snapshot: snapshot,
      first_role_prepay_selected: true,
      first_role_prepay_amount_cents: 35900,
      first_role_normal_role_fee_cents: 39900,
      first_role_prepay_discount_percent: 10,
      first_role_prepay_credit_type: 'first_role_prepay'
    })]
  })
  const response = await postAgreement(buildApp(db), BASIC_INTENT_ID)

  assert.equal(response.status, 201)
  const agreement = db.inserts[0].row
  assert.equal(agreement.template_snapshot.purchase_intent.first_role_prepay_selected, true)
  assert.equal(agreement.template_snapshot.package_snapshot.first_role_prepay.selected, true)
  assert.equal(agreement.template_snapshot.values.first_role_prepay.selected, true)
  assert.match(agreement.template_snapshot.rendered_html, /optional discounted first-role prepayment/)
  assert.match(agreement.template_snapshot.rendered_html, /\$359\.00/)
  assert.match(agreement.template_snapshot.rendered_html, /non-refundable/)
  assert.match(agreement.template_snapshot.rendered_html, /no expiration/)
  assert.match(agreement.template_snapshot.rendered_html, /billing entity/)
  assert.match(agreement.template_snapshot.rendered_html, /Membership changes require client success\/support review/)
})

test('public purchase agreement renders pay-later first-role terms when selected false', async () => {
  const snapshot = buildAlphaScreenPackageSnapshot('pro', 'annual')
  const db = makeDb({
    purchaseIntents: [intent({
      id: PRO_INTENT_ID,
      selected_plan_key: 'pro',
      selected_billing_cadence: 'annual',
      package_snapshot: snapshot,
      first_role_prepay_selected: false
    })]
  })
  const response = await postAgreement(buildApp(db), PRO_INTENT_ID)

  assert.equal(response.status, 201)
  const html = db.inserts[0].row.template_snapshot.rendered_html
  assert.match(html, /Client did not prepay the first role/)
  assert.match(html, /standard per-role fee is charged/)
  assert.doesNotMatch(html, /optional discounted first-role prepayment/)
})

test('valid pending Pro purchase intent creates agreement with Pro snapshot values', async () => {
  const db = makeDb({
    purchaseIntents: [intent({
      id: PRO_INTENT_ID,
      selected_plan_key: 'pro',
      selected_billing_cadence: 'annual',
      package_snapshot: {
        plan_key: 'pro',
        display_name: 'Pro',
        billing_cadence: 'annual',
        platform_fee: 6499,
        platform_fee_cents: 649900,
        platform_fee_billing_cadence: 'annual',
        platform_monthly_fee: 599,
        platform_monthly_fee_cents: 59900,
        platform_annual_fee: 6499,
        platform_annual_fee_cents: 649900,
        annual_platform_fee_note: 'Discounted annual platform fee',
        included_interviews: 30,
        included_interviews_per_role: 30,
        interview_duration_minutes: 12,
        max_interview_minutes: 12,
        additional_interview_price: 35,
        additional_interview_fee: 35,
        overage_price: 35,
        per_role_fee: 699
      }
    })]
  })
  const response = await postAgreement(buildApp(db), PRO_INTENT_ID)

  assert.equal(response.status, 201)
  const agreement = db.inserts[0].row
  assert.equal(agreement.membership_tier, 'pro')
  assert.equal(agreement.billing_option, 'annual')
  assert.equal(agreement.template_snapshot.values.included_interviews_per_role, '30')
  assert.equal(agreement.template_snapshot.values.max_interview_minutes, '12')
  assert.equal(agreement.template_snapshot.values.platform_fee, '6499')
  assert.equal(agreement.template_snapshot.values.additional_interview_fee, '35')
  assert.equal(agreement.template_snapshot.values.per_role_fee, '699')
  assert.equal(response.body.agreement.selected_package.platform_fee, 6499)
  assert.equal(response.body.agreement.selected_package.platform_monthly_fee, 599)
  assert.equal(response.body.agreement.selected_package.platform_annual_fee, 6499)
  assert.equal(response.body.agreement.selected_package.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(response.body.agreement.selected_package.included_interviews, 30)
  assert.equal(response.body.agreement.selected_package.max_interview_minutes, 12)
  assert.equal(response.body.agreement.selected_package.additional_interview_fee, 35)
})

test('checkout status endpoint returns completed webhook setup state without raw checkout payloads', async () => {
  const clientId = '44444444-4444-4444-8444-444444444444'
  const db = makeDb({
    purchaseIntents: [intent({
      status: 'completed',
      agreement_id: AGREEMENT_ID,
      stripe_checkout_session_id: 'cs_test_public',
      client_id: clientId
    })],
    membershipAgreements: [{
      id: AGREEMENT_ID,
      client_id: clientId,
      checkout_status: 'paid',
      checkout_session_id: 'cs_test_public'
    }],
    clients: [{
      id: clientId,
      billing_status: 'active',
      subscription_status: 'active'
    }],
    clientMembers: [{
      client_id: clientId,
      email: 'alex@acmedental.example',
      role: 'manager',
      user_id: 'user-new-buyer'
    }],
    authUsers: [{ id: 'user-new-buyer', email: 'alex@acmedental.example' }],
    setupActionLink: 'https://qa.alphasourceai.com/pwreset?token_hash=direct-setup-token&type=recovery'
  })

  const response = await getCheckoutStatus(buildApp(db), {
    session_id: 'cs_test_public',
    agreement_id: AGREEMENT_ID,
    client_id: clientId
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'password_required')
  assert.equal(response.body.client_id, clientId)
  assert.equal(response.body.password_setup_required, true)
  assert.equal(response.body.direct_setup_available, true)
  assert.equal(response.body.setup_email_sent, false)
  assert.match(response.body.set_password_url, /\/pwreset\?token_hash=direct-setup-token/)
  assert.doesNotMatch(JSON.stringify(response.body), /buyer_email|company_legal_name|raw_payload|stripe_checkout_session_id|signer_token|sk_test|sk_live/i)
})

test('purchase intent agreement endpoint is idempotent for an existing sent agreement', async () => {
  const db = makeDb({
    purchaseIntents: [intent({ status: 'agreement_pending', agreement_id: AGREEMENT_ID })],
    membershipAgreements: [{
      id: AGREEMENT_ID,
      status: 'sent',
      signer_token_hash: 'old-hash',
      signer_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      draft_pdf_path: 'membership-agreements/existing/acme-draft.pdf',
      sent_at: new Date().toISOString()
    }]
  })
  const response = await postAgreement(buildApp(db), BASIC_INTENT_ID)

  assert.equal(response.status, 200)
  assert.equal(response.body.agreement.id, AGREEMENT_ID)
  assert.equal(response.body.agreement.refreshed, true)
  assert.equal(db.inserts.length, 0)
  const agreementUpdate = db.updates.find((update) => update.table === 'membership_agreements')
  assert.ok(agreementUpdate)
  assert.notEqual(agreementUpdate.payload.signer_token_hash, 'old-hash')
  assert.match(response.body.agreement.signing_url, /\/membership-agreement\/sign\//)
})

test('purchase intent agreement endpoint rejects missing, expired, ineligible, and invalid snapshot intents', async () => {
  const cases = [
    [makeDb({ purchaseIntents: [] }), BASIC_INTENT_ID, 404, 'purchase_intent_not_found'],
    [makeDb({ purchaseIntents: [intent({ expires_at: new Date(Date.now() - 1000).toISOString() })] }), BASIC_INTENT_ID, 410, 'purchase_intent_expired'],
    [makeDb({ purchaseIntents: [intent({ status: 'completed' })] }), BASIC_INTENT_ID, 409, 'purchase_intent_not_eligible'],
    [makeDb({ purchaseIntents: [intent({ package_snapshot: {} })] }), BASIC_INTENT_ID, 409, 'package_snapshot_missing'],
    [makeDb({ purchaseIntents: [intent()] }), 'not-a-uuid', 400, 'purchase_intent_id_required']
  ]

  for (const [db, intentId, status, code] of cases) {
    const response = await postAgreement(buildApp(db), intentId)
    assert.equal(response.status, status)
    assert.equal(response.body.code, code)
    assert.equal(db.inserts.length, 0)
  }
})

test('purchase intent agreement endpoint requires matching retail email or text verification', async () => {
  const db = makeDb({
    purchaseIntents: [intent({
      email_verified_at: null,
      email_verified_address: null,
      email_verification_method: null,
      email_verification_version: null
    })]
  })
  const response = await postAgreement(buildApp(db), BASIC_INTENT_ID)

  assert.equal(response.status, 409)
  assert.equal(response.body.code, 'RETAIL_CONTACT_VERIFICATION_REQUIRED')
  assert.equal(db.inserts.length, 0)
  assert.deepEqual(Array.from(new Set(db.touchedTables)).sort(), ['public_purchase_intents'])

  const changedEmailDb = makeDb({
    purchaseIntents: [intent({
      buyer_email: 'new-buyer@acmedental.example',
      email_verified_address: 'alex@acmedental.example'
    })]
  })
  const changedEmailResponse = await postAgreement(buildApp(changedEmailDb), BASIC_INTENT_ID)

  assert.equal(changedEmailResponse.status, 409)
  assert.equal(changedEmailResponse.body.code, 'RETAIL_CONTACT_VERIFICATION_REQUIRED')
  assert.equal(changedEmailDb.inserts.length, 0)
})

test('purchase intent agreement response is safe and creates no Stripe, client, user, or membership access records', async () => {
  const db = makeDb({ purchaseIntents: [intent()] })
  const response = await postAgreement(buildApp(db), BASIC_INTENT_ID, {
    'user-agent': 'raw-test-agent',
    'x-forwarded-for': '203.0.113.55'
  })

  assert.equal(response.status, 201)
  const touched = Array.from(new Set(db.touchedTables)).sort()
  assert.deepEqual(touched, ['membership_agreements', 'public_purchase_intents'])
  const serializedResponse = JSON.stringify(response.body)
  assert.doesNotMatch(serializedResponse, /signer_token_hash|sk_live|sk_test|raw-test-agent|203\.0\.113\.55|buyer_email|company_legal_name/i)
  assert.equal(db.inserts[0].row.client_id, null)
  assert.equal(db.inserts[0].row.checkout_status, undefined)
  assert.equal(db.inserts[0].row.checkout_session_id, undefined)
})

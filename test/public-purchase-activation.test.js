'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const projectRoot = path.resolve(__dirname, '..')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const mailerPath = path.join(projectRoot, 'src', 'clients', 'sendgrid.js')
const sendgridMailPath = require.resolve('@sendgrid/mail')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: {
    supabaseAdmin: {
      auth: { admin: {} }
    }
  }
}

const {
  activatePublicPurchaseAgreementCheckout,
  resolvePublicCheckoutReturnState
} = require('../src/services/publicPurchaseActivation')
const { buildAlphaScreenPackageSnapshot } = require('../src/services/alphaScreenPackages')

const AGREEMENT_ID = '33333333-3333-4333-8333-333333333333'
const INTENT_ID = '11111111-1111-4111-8111-111111111111'
const CLIENT_ID = '44444444-4444-4444-8444-444444444444'
const BUYER_EMAIL = 'alex@acmedental.example'

function matchesFilters(row, filters) {
  return filters.every(({ column, value, op = 'eq' }) => {
    if (op === 'is') return value === null ? row?.[column] == null : row?.[column] === value
    if (op === 'neq') return String(row?.[column] ?? '') !== String(value ?? '')
    return String(row?.[column] ?? '') === String(value ?? '')
  })
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.insertPayload = null
    this.updatePayload = null
    this.upsertPayload = null
  }

  select(columns) {
    this.selectColumns = columns
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value, op: 'eq' })
    return this
  }

  neq(column, value) {
    this.filters.push({ column, value, op: 'neq' })
    return this
  }

  is(column, value) {
    this.filters.push({ column, value, op: 'is' })
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

  upsert(payload, options = {}) {
    this.upsertPayload = payload
    this.upsertOptions = options
    return this
  }

  rows() {
    if (this.table === 'membership_agreements') return this.db.membershipAgreements
    if (this.table === 'public_purchase_intents') return this.db.purchaseIntents
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'client_members') return this.db.clientMembers
    if (this.table === 'client_plan_settings') return this.db.clientPlanSettings
    if (this.table === 'email_delivery_events') return this.db.emailDeliveryEvents
    if (this.table === 'client_role_credits') return this.db.clientRoleCredits
    return []
  }

  async maybeSingle() {
    const rows = this.rows().filter((item) => matchesFilters(item, this.filters))
    const row = rows[0] || null
    if (row && this.updatePayload) {
      for (const item of rows) Object.assign(item, this.updatePayload)
      this.db.updates.push({ table: this.table, rows, payload: this.updatePayload })
    }
    return { data: row, error: null }
  }

  async single() {
    if (this.insertPayload) {
      const row = { ...this.insertPayload }
      if (this.table === 'email_delivery_events' && row.sg_event_id) {
        const duplicate = this.rows().find((item) => String(item.sg_event_id || '') === String(row.sg_event_id || ''))
        if (duplicate) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
      }
      if (this.table === 'client_role_credits') {
        const duplicate = this.rows().find((item) => {
          const sameIntent = row.source_public_purchase_intent_id && String(item.source_public_purchase_intent_id || '') === String(row.source_public_purchase_intent_id || '')
          const sameSession = row.source_stripe_checkout_session_id && String(item.source_stripe_checkout_session_id || '') === String(row.source_stripe_checkout_session_id || '')
          return sameIntent || sameSession
        })
        if (duplicate) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        if (!row.id) row.id = `credit-${this.rows().length + 1}`
      }
      if (this.table === 'clients' && !row.id) row.id = CLIENT_ID
      this.rows().push(row)
      this.db.inserts.push({ table: this.table, row })
      return { data: row, error: null }
    }
    if (this.updatePayload) {
      const rows = this.rows().filter((item) => matchesFilters(item, this.filters))
      const row = rows[0] || null
      if (!row) return { data: null, error: { message: 'row_not_found', code: 'PGRST116' } }
      for (const item of rows) Object.assign(item, this.updatePayload)
      this.db.updates.push({ table: this.table, rows, payload: this.updatePayload })
      return { data: row, error: null }
    }
    return this.maybeSingle()
  }

  async execute() {
    if (this.upsertPayload) {
      const rows = this.rows()
      const existing = rows.find((row) => String(row.client_id || '') === String(this.upsertPayload.client_id || ''))
      if (existing) Object.assign(existing, this.upsertPayload)
      else rows.push({ ...this.upsertPayload })
      this.db.upserts.push({ table: this.table, payload: this.upsertPayload, options: this.upsertOptions })
      return { data: this.upsertPayload, error: null }
    }
    if (this.insertPayload) return this.single()
    if (this.updatePayload) {
      const rows = this.rows().filter((item) => matchesFilters(item, this.filters))
      for (const item of rows) Object.assign(item, this.updatePayload)
      this.db.updates.push({ table: this.table, rows, payload: this.updatePayload })
      return { data: rows, error: null }
    }
    return { data: this.rows().filter((item) => matchesFilters(item, this.filters)), error: null }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeAgreement(plan = 'basic', cadence = 'monthly', options = {}) {
  const packageSnapshot = buildAlphaScreenPackageSnapshot(plan, cadence, {
    firstRolePrepaySelected: options.firstRolePrepaySelected === true
  })
  return {
    id: AGREEMENT_ID,
    client_id: CLIENT_ID,
    status: 'signed',
    is_current: true,
    checkout_status: 'pending_payment',
    checkout_session_id: 'cs_test_public',
    primary_admin_name: 'Alex Rivera',
    admin_email: BUYER_EMAIL,
    client_legal_name: 'Acme Dental Group',
    dba_trade_name: 'Acme Dental',
    membership_tier: plan,
    billing_option: cadence,
    auto_renew: true,
    template_snapshot: {
      source: options.source || 'public_purchase_intent',
      purchase_intent: { id: INTENT_ID },
      package_snapshot: packageSnapshot
    }
  }
}

function makeIntent(plan = 'basic', cadence = 'monthly', options = {}) {
  const packageSnapshot = buildAlphaScreenPackageSnapshot(plan, cadence, {
    firstRolePrepaySelected: options.firstRolePrepaySelected === true
  })
  return {
    id: INTENT_ID,
    status: 'checkout_pending',
    selected_plan_key: plan,
    selected_billing_cadence: cadence,
    package_snapshot: packageSnapshot,
    first_role_prepay_selected: options.firstRolePrepaySelected === true,
    first_role_prepay_amount_cents: options.firstRolePrepaySelected === true ? packageSnapshot.first_role_prepay.discounted_credit_amount_cents : null,
    first_role_normal_role_fee_cents: options.firstRolePrepaySelected === true ? packageSnapshot.first_role_prepay.normal_role_fee_cents : null,
    first_role_prepay_discount_percent: options.firstRolePrepaySelected === true ? packageSnapshot.first_role_prepay.discount_percent : null,
    first_role_prepay_credit_type: options.firstRolePrepaySelected === true ? packageSnapshot.first_role_prepay.credit_type : null,
    company_legal_name: 'Acme Dental Group',
    company_dba: 'Acme Dental',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: BUYER_EMAIL,
    agreement_id: AGREEMENT_ID,
    stripe_checkout_session_id: 'cs_test_public',
    client_id: CLIENT_ID,
    term_start_basis: options.termStartBasis || 'agreement_date'
  }
}

function makeDb(plan = 'basic', cadence = 'monthly', overrides = {}) {
  return {
    membershipAgreements: [makeAgreement(plan, cadence, overrides)],
    purchaseIntents: [makeIntent(plan, cadence, overrides)],
    clients: [{
      id: CLIENT_ID,
      name: 'Acme Dental Group',
      email: BUYER_EMAIL,
      client_admin_name: 'Alex Rivera',
      billing_status: 'inactive',
      subscription_status: 'incomplete',
      plan_tier: plan,
      billing_interval: cadence
    }],
    clientMembers: overrides.clientMembers ? [...overrides.clientMembers] : [],
    clientPlanSettings: [],
    emailDeliveryEvents: overrides.emailDeliveryEvents ? [...overrides.emailDeliveryEvents] : [],
    clientRoleCredits: overrides.clientRoleCredits ? [...overrides.clientRoleCredits] : [],
    inserts: [],
    updates: [],
    upserts: [],
    from(table) {
      return new FakeQuery(this, table)
    }
  }
}

function makeAuthAdmin(users = [], options = {}) {
  return {
    calls: [],
    async listUsers(args) {
      this.calls.push(args)
      return { data: { users }, error: null }
    },
    async getUserById(userId) {
      const user = users.find((item) => String(item?.id || '') === String(userId || '')) || null
      return { data: { user }, error: null }
    },
    async generateLink(args) {
      this.calls.push(args)
      if (options.generateLinkError) throw options.generateLinkError
      return {
        data: {
          action_link: options.actionLink || 'https://qa.alphasourceai.com/pwreset?token_hash=direct-setup-token&type=recovery'
        },
        error: null
      }
    }
  }
}

function makeSubscription(cadence) {
  return {
    id: 'sub_test_public',
    status: 'active',
    customer: 'cus_test_public',
    start_date: 1782172800,
    current_period_end: cadence === 'annual' ? 1813708800 : 1784851200,
    cancel_at_period_end: false,
    items: {
      data: [{
        price: {
          recurring: {
            interval: cadence === 'annual' ? 'year' : 'month'
          }
        }
      }]
    }
  }
}

async function activateCase(plan, cadence, extra = {}) {
  const db = extra.db || makeDb(plan, cadence, extra)
  const sentEmails = []
  const welcomeEmails = []
  let recoveryCalls = 0
  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: extra.authAdmin || makeAuthAdmin(extra.users || []),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription(cadence),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      recoveryCalls += 1
      return { userId: 'user-new-buyer', method: 'createUser', actionLink: 'https://setup.example/recovery-token' }
    },
    sendRecoveryEmail: async (to, actionLink, name) => {
      sentEmails.push({ to, actionLink, name })
      return { statusCode: 202 }
    },
    sendWelcomeEmail: extra.sendWelcomeEmail || (async (to, details) => {
      welcomeEmails.push({ to, details })
      return { statusCode: 202 }
    }),
    logger: {
      error() {},
      warn() {},
      info() {}
    }
  })
  return { db, result, sentEmails, welcomeEmails, recoveryCalls }
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  }
}

test('public purchase webhook activation provisions Essential and Pro monthly/annual buyers', async () => {
  // The last column is the billing model the tier provisions: Essentials keeps a
  // per-role allowance, Pro rolls the unused part over as client credit.
  const cases = [
    ['basic', 'monthly', 299, 399, 20, 10, 30, 'fixed'],
    ['basic', 'annual', 3299, 399, 20, 10, 30, 'fixed'],
    ['pro', 'monthly', 599, 699, 30, 12, 35, 'rollover'],
    ['pro', 'annual', 6499, 699, 30, 12, 35, 'rollover']
  ]

  for (const [plan, cadence, platformFee, perRoleFee, included, minutes, overage, billingModel] of cases) {
    const { db, result, sentEmails, welcomeEmails, recoveryCalls } = await activateCase(plan, cadence)

    assert.equal(result.ok, true)
    assert.equal(result.plan_key, plan)
    assert.equal(result.billing_interval, cadence)
    assert.equal(result.client_id, CLIENT_ID)
    assert.equal(result.setup_email_status, 'sent')
    assert.equal(result.welcome_email_status, 'sent')
    assert.equal(result.first_role_credit_status, 'not_selected')
    assert.equal(recoveryCalls, 1)
    assert.equal(sentEmails.length, 1)
    assert.equal(sentEmails[0].to, BUYER_EMAIL)
    assert.equal(welcomeEmails.length, 1)
    assert.equal(welcomeEmails[0].to, BUYER_EMAIL)
    assert.equal(db.emailDeliveryEvents.length, 1)
    assert.equal(db.emailDeliveryEvents[0].email_category, 'public_purchase_welcome')
    assert.equal(db.emailDeliveryEvents[0].status, 'sent')
    assert.equal(db.clientRoleCredits.length, 0)

    const agreement = db.membershipAgreements[0]
    assert.equal(agreement.checkout_status, 'paid')
    assert.equal(agreement.checkout_paid_at, '2026-06-23T12:00:00.000Z')

    const intent = db.purchaseIntents[0]
    assert.equal(intent.status, 'completed')
    assert.equal(intent.stripe_checkout_session_id, 'cs_test_public')

    const client = db.clients[0]
    assert.equal(client.billing_status, 'active')
    assert.equal(client.subscription_status, 'active')
    assert.equal(client.plan_tier, plan)
    assert.equal(client.billing_interval, cadence)

    assert.equal(db.clientMembers.length, 1)
    assert.equal(db.clientMembers[0].email, BUYER_EMAIL)
    assert.equal(db.clientMembers[0].user_id, 'user-new-buyer')
    assert.equal(db.clientMembers[0].role, 'manager')

    const settings = db.clientPlanSettings[0]
    assert.deepEqual(settings, {
      client_id: CLIENT_ID,
      plan_tier: plan,
      billing_interval: cadence,
      platform_fee: platformFee,
      per_role_fee: perRoleFee,
      included_interviews_per_role: included,
      additional_interview_fee: overage,
      max_interview_minutes: minutes,
      billing_model: billingModel
    })
    assert.doesNotMatch(JSON.stringify(result), /recovery-token|setup\.example/)
  }
})

test('public purchase webhook activation does not reactivate a canceled sales intent', async () => {
  const db = makeDb('basic', 'monthly', { source: 'sales_assisted' })
  db.purchaseIntents[0].status = 'canceled'
  db.purchaseIntents[0].canceled_at = '2026-09-18T19:00:00.000Z'
  const beforeClient = { ...db.clients[0] }

  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-09-18T19:01:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    logger: { error() {}, warn() {}, info() {} }
  })

  assert.deepEqual(result, { ok: false, status: 'purchase_canceled', purchase_intent_id: INTENT_ID })
  assert.deepEqual(db.clients[0], beforeClient)
  assert.equal(db.updates.length, 0)
  assert.equal(db.inserts.length, 0)
})

test('sales-assisted activation starts the membership on successful payment', async () => {
  const db = makeDb('basic', 'monthly', {
    source: 'sales_assisted',
    termStartBasis: 'successful_payment'
  })
  const { result } = await activateCase('basic', 'monthly', { db })
  assert.equal(result.ok, true)
  assert.equal(db.membershipAgreements[0].initial_term_start, '2026-06-23')
  assert.equal(db.membershipAgreements[0].initial_renewal_date, '2027-06-23')
  assert.equal(db.purchaseIntents[0].activated_at, '2026-06-23T12:00:00.000Z')
})

test('new sales-assisted activation preserves concrete agreement dates', async () => {
  const db = makeDb('pro', 'annual', { source: 'sales_assisted', termStartBasis: 'agreement_date' })
  db.membershipAgreements[0].initial_term_start = '2026-09-19'
  db.membershipAgreements[0].initial_renewal_date = '2027-09-19'
  const { result } = await activateCase('pro', 'annual', { db })
  assert.equal(result.ok, true)
  assert.equal(db.membershipAgreements[0].initial_term_start, '2026-09-19')
  assert.equal(db.membershipAgreements[0].initial_renewal_date, '2027-09-19')
})

test('public purchase activation creates first-role prepay credit once when selected', async () => {
  const db = makeDb('basic', 'monthly', { firstRolePrepaySelected: true })
  const commonOptions = {
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async (_db, clientId) => ({ ok: true, clientId }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async () => ({ statusCode: 202 }),
    logger: { error() {}, warn() {}, info() {} }
  }

  const first = await activatePublicPurchaseAgreementCheckout(commonOptions)
  const second = await activatePublicPurchaseAgreementCheckout(commonOptions)

  assert.equal(first.first_role_credit_status, 'created')
  assert.equal(second.first_role_credit_status, 'already_created')
  assert.equal(db.clientRoleCredits.length, 1)
  const credit = db.clientRoleCredits[0]
  assert.equal(credit.billing_client_id, CLIENT_ID)
  assert.equal(credit.source_client_id, CLIENT_ID)
  assert.equal(credit.source_public_purchase_intent_id, INTENT_ID)
  assert.equal(credit.source_membership_agreement_id, AGREEMENT_ID)
  assert.equal(credit.source_stripe_checkout_session_id, 'cs_test_public')
  assert.equal(credit.credit_type, 'first_role_prepay')
  assert.equal(credit.membership_key, 'basic')
  assert.equal(credit.normal_role_fee_cents, 39900)
  assert.equal(credit.discounted_credit_amount_cents, 35900)
  assert.equal(credit.discount_percent, 10)
  assert.equal(credit.status, 'unused')
  assert.equal(credit.used_at, undefined)
  assert.equal(credit.used_by_role_id, undefined)
  assert.equal(credit.metadata.non_refundable, true)
  assert.equal(credit.metadata.expires, false)
})

test('public purchase activation links an existing auth user without sending setup email', async () => {
  let recoveryCalled = false
  let emailCalled = false
  const welcomeEmails = []
  const db = makeDb('pro', 'annual')
  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL, last_sign_in_at: '2026-06-20T00:00:00Z' }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('annual'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      recoveryCalled = true
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      emailCalled = true
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async (to, details) => {
      welcomeEmails.push({ to, details })
      return { statusCode: 202 }
    },
    logger: { error() {}, warn() {} }
  })

  assert.equal(result.auth_status, 'existing_user')
  assert.equal(result.setup_email_status, 'not_sent_existing_user')
  assert.equal(result.welcome_email_status, 'sent')
  assert.equal(recoveryCalled, false)
  assert.equal(emailCalled, false)
  assert.equal(welcomeEmails.length, 1)
  assert.equal(db.clientMembers.length, 1)
  assert.equal(db.clientMembers[0].user_id, 'user-existing')
  assert.equal(db.clientMembers[0].role, 'manager')
})

test('public purchase activation reuses existing member row idempotently', async () => {
  const welcomeEmails = []
  const db = makeDb('basic', 'monthly', {
    clientMembers: [{
      client_id: CLIENT_ID,
      email: BUYER_EMAIL,
      name: 'Alex Rivera',
      role: 'manager',
      user_id: 'user-existing'
    }]
  })
  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_member')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_member')
    },
    sendWelcomeEmail: async (to, details) => {
      welcomeEmails.push({ to, details })
      return { statusCode: 202 }
    },
    logger: { error() {}, warn() {} }
  })

  assert.equal(result.member_status, 'existing')
  assert.equal(result.welcome_email_status, 'sent')
  assert.equal(welcomeEmails.length, 1)
  assert.equal(db.clientMembers.length, 1)
  assert.equal(db.inserts.filter((entry) => entry.table === 'client_members').length, 0)
})

test('duplicate public purchase webhook activation does not resend welcome email', async () => {
  const db = makeDb('basic', 'monthly')
  const welcomeEmails = []
  const commonOptions = {
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async (to, details) => {
      welcomeEmails.push({ to, details })
      return { statusCode: 202 }
    },
    logger: { error() {}, warn() {} }
  }

  const first = await activatePublicPurchaseAgreementCheckout(commonOptions)
  const second = await activatePublicPurchaseAgreementCheckout(commonOptions)

  assert.equal(first.welcome_email_status, 'sent')
  assert.equal(second.welcome_email_status, 'already_sent')
  assert.equal(welcomeEmails.length, 1)
  assert.equal(db.emailDeliveryEvents.filter((row) => row.email_category === 'public_purchase_welcome').length, 1)
})

test('hosted-like public purchase activation sends welcome when webhook pre-activated client', async () => {
  const db = makeDb('basic', 'monthly')
  db.clients[0].billing_status = 'active'
  db.clients[0].subscription_status = 'active'
  db.clients[0].stripe_subscription_id = 'sub_test_public'
  const welcomeEmails = []

  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async (to, details) => {
      welcomeEmails.push({ to, details })
      return { statusCode: 202 }
    },
    logger: { error() {}, warn() {}, info() {} }
  })

  assert.equal(result.welcome_email_status, 'sent')
  assert.equal(welcomeEmails.length, 1)
  assert.equal(welcomeEmails[0].to, BUYER_EMAIL)
  assert.equal(db.emailDeliveryEvents[0].status, 'sent')
})

test('skipped welcome email can retry on duplicate webhook instead of being treated as sent', async () => {
  const db = makeDb('basic', 'monthly')
  const welcomeCalls = []
  const loggerEntries = []
  const commonOptions = {
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async (to, details) => {
      welcomeCalls.push({ to, details })
      return welcomeCalls.length === 1 ? { skipped: true } : { statusCode: 202 }
    },
    logger: {
      error(...args) { loggerEntries.push(args) },
      warn(...args) { loggerEntries.push(args) },
      info(...args) { loggerEntries.push(args) }
    }
  }

  const first = await activatePublicPurchaseAgreementCheckout(commonOptions)
  const second = await activatePublicPurchaseAgreementCheckout(commonOptions)

  assert.equal(first.welcome_email_status, 'skipped')
  assert.equal(second.welcome_email_status, 'sent')
  assert.equal(welcomeCalls.length, 2)
  assert.equal(db.emailDeliveryEvents.length, 1)
  assert.equal(db.emailDeliveryEvents[0].status, 'sent')
  assert.equal(db.emailDeliveryEvents[0].attempt, 2)
  assert.doesNotMatch(JSON.stringify(loggerEntries), /recovery-token|setup\.example|raw_payload|sk_test|SG\./)
})

test('public purchase activation does not send welcome email when activation fails', async () => {
  const db = makeDb('basic', 'monthly')
  let welcomeCalled = false
  await assert.rejects(
    activatePublicPurchaseAgreementCheckout({
      db,
      authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL }]),
      agreementId: AGREEMENT_ID,
      checkoutSessionId: 'cs_test_public',
      paidAt: '2026-06-23T12:00:00.000Z',
      subscription: makeSubscription('monthly'),
      requireParentClient: async () => ({
        ok: false,
        body: { error: 'client_scope_invalid', detail: 'Client scope invalid.' }
      }),
      sendWelcomeEmail: async () => {
        welcomeCalled = true
        return { statusCode: 202 }
      },
      logger: { error() {}, warn() {} }
    }),
    /Client scope invalid/
  )

  assert.equal(welcomeCalled, false)
  assert.equal(db.emailDeliveryEvents.length, 0)
})

test('public purchase activation does not log setup action links', async () => {
  const db = makeDb('basic', 'monthly')
  const logEntries = []

  const result = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => ({
      userId: 'user-new-buyer',
      method: 'createUser',
      actionLink: 'https://setup.example/recovery-token'
    }),
    sendRecoveryEmail: async () => ({ skipped: true }),
    sendWelcomeEmail: async () => ({ skipped: true }),
    logger: {
      error(...args) { logEntries.push(args) },
      warn(...args) { logEntries.push(args) }
    }
  })

  assert.equal(result.setup_email_status, 'skipped')
  assert.doesNotMatch(JSON.stringify(result), /recovery-token|setup\.example/)
  assert.doesNotMatch(JSON.stringify(logEntries), /recovery-token|setup\.example/)
})

test('checkout return state provides direct setup URL even when setup email failed', async () => {
  const db = makeDb('basic', 'monthly')
  const logEntries = []

  const activation = await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('monthly'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => ({
      userId: 'user-new-buyer',
      method: 'createUser',
      actionLink: 'https://setup.example/recovery-token'
    }),
    sendRecoveryEmail: async () => {
      throw new Error('sendgrid unavailable')
    },
    sendWelcomeEmail: async () => ({ statusCode: 202 }),
    logger: {
      error(...args) { logEntries.push(args) },
      warn(...args) { logEntries.push(args) },
      info(...args) { logEntries.push(args) }
    }
  })

  assert.equal(activation.setup_email_status, 'send_failed')
  assert.doesNotMatch(JSON.stringify(activation), /recovery-token|setup\.example/)
  assert.doesNotMatch(JSON.stringify(logEntries), /recovery-token|setup\.example/)

  const status = await resolvePublicCheckoutReturnState({
    db,
    authAdmin: makeAuthAdmin(
      [{ id: 'user-new-buyer', email: BUYER_EMAIL }],
      { actionLink: 'https://qa.alphasourceai.com/pwreset?token_hash=direct-after-email-failure&type=recovery' }
    ),
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID,
    logger: {
      warn(...args) { logEntries.push(args) },
      error(...args) { logEntries.push(args) }
    }
  })

  assert.equal(status.status, 'password_required')
  assert.equal(status.password_setup_required, true)
  assert.match(status.set_password_url, /direct-after-email-failure/)
  assert.doesNotMatch(JSON.stringify(logEntries), /direct-after-email-failure|recovery-token|setup\.example/)
})

test('checkout return state reads webhook state and does not activate pending rows', async () => {
  const db = makeDb('basic', 'monthly')
  const status = await resolvePublicCheckoutReturnState({
    db,
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID
  })

  assert.equal(status.status, 'payment_pending')
  assert.equal(status.set_password_url, undefined)
  assert.equal(db.updates.length, 0)
  assert.equal(db.inserts.length, 0)
  assert.equal(db.emailDeliveryEvents.length, 0)

  await activateCase('basic', 'monthly', { db })
  const passwordRequiredStatus = await resolvePublicCheckoutReturnState({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-new-buyer', email: BUYER_EMAIL }]),
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID
  })
  assert.equal(passwordRequiredStatus.status, 'password_required')
  assert.equal(passwordRequiredStatus.password_setup_required, true)
  assert.equal(passwordRequiredStatus.direct_setup_available, true)
  assert.match(passwordRequiredStatus.set_password_url, /\/pwreset\?token_hash=direct-setup-token/)
  assert.doesNotMatch(JSON.stringify(passwordRequiredStatus), /buyer_email|company_legal_name|raw_payload|sk_test|sk_live/i)

  const emailFallbackStatus = await resolvePublicCheckoutReturnState({
    db,
    authAdmin: makeAuthAdmin(
      [{ id: 'user-new-buyer', email: BUYER_EMAIL }],
      { generateLinkError: new Error('setup link unavailable') }
    ),
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID,
    logger: { warn() {}, error() {} }
  })
  assert.equal(emailFallbackStatus.status, 'setup_email_sent')
  assert.equal(emailFallbackStatus.password_setup_required, true)
  assert.equal(emailFallbackStatus.setup_email_sent, true)
  assert.equal(emailFallbackStatus.set_password_url, undefined)

  const readyDb = makeDb('pro', 'annual', {
    clientMembers: [{
      client_id: CLIENT_ID,
      email: BUYER_EMAIL,
      name: 'Alex Rivera',
      role: 'manager',
      user_id: 'user-existing'
    }]
  })
  readyDb.membershipAgreements[0].checkout_status = 'paid'
  readyDb.purchaseIntents[0].status = 'completed'
  readyDb.clients[0].billing_status = 'active'
  readyDb.clients[0].subscription_status = 'active'
  const readyStatus = await resolvePublicCheckoutReturnState({
    db: readyDb,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL, last_sign_in_at: '2026-06-20T00:00:00.000Z' }]),
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID
  })
  assert.equal(readyStatus.status, 'ready')
  assert.equal(readyStatus.client_id, CLIENT_ID)
})

test('sendAlphaScreenWelcomeEmail renders updated copy and attaches getting-started playbook', async () => {
  const originalApiKey = process.env.SENDGRID_API_KEY
  const originalHelpEmail = process.env.BRANDED_EMAIL_HELP_EMAIL
  const sentMessages = []
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphascreen-welcome-playbook-'))
  const playbookPath = path.join(tempDir, 'alphascreen-getting-started-playbook.pdf')
  fs.writeFileSync(playbookPath, Buffer.from('%PDF-1.4 test playbook\n'))
  delete require.cache[mailerPath]
  delete require.cache[sendgridMailPath]
  injectModule(sendgridMailPath, {
    setApiKey() {},
    async send(message) {
      sentMessages.push(message)
      return [{ statusCode: 202 }]
    },
  })
  process.env.SENDGRID_API_KEY = 'test-key'
  process.env.BRANDED_EMAIL_HELP_EMAIL = 'support@alphasourceai.com'
  try {
    const { sendAlphaScreenWelcomeEmail } = require(mailerPath)
    await sendAlphaScreenWelcomeEmail(BUYER_EMAIL, {
      firstName: 'Alex',
      clientId: CLIENT_ID,
      agreementId: AGREEMENT_ID,
      purchaseIntentId: INTENT_ID,
      playbookAttachmentPath: playbookPath
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY
    else process.env.SENDGRID_API_KEY = originalApiKey
    if (originalHelpEmail === undefined) delete process.env.BRANDED_EMAIL_HELP_EMAIL
    else process.env.BRANDED_EMAIL_HELP_EMAIL = originalHelpEmail
    delete require.cache[mailerPath]
    delete require.cache[sendgridMailPath]
  }

  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].subject, 'Welcome to alphaScreen')
  assert.equal(sentMessages[0].customArgs.email_category, 'public_purchase_welcome')
  assert.equal(sentMessages[0].attachments.length, 1)
  assert.equal(sentMessages[0].attachments[0].filename, 'alphaScreen Getting Started Playbook.pdf')
  assert.equal(sentMessages[0].attachments[0].type, 'application/pdf')
  assert.equal(sentMessages[0].attachments[0].disposition, 'attachment')
  assert.equal(sentMessages[0].attachments[0].content, Buffer.from('%PDF-1.4 test playbook\n').toString('base64'))
  const messageBody = `${sentMessages[0].text || ''}\n${sentMessages[0].html || ''}`
  assert.match(messageBody, /support@alphasourceai\.com/)
  assert.match(messageBody, /set your password using the setup email/)
  assert.match(messageBody, /review the AI-generated screening questions/)
  assert.match(messageBody, /Review the AI-generated screening questions before inviting candidates/)
  assert.match(messageBody, /The attached alphaScreen playbook walks through the recommended getting-started flow/)
  assert.doesNotMatch(messageBody, /add screening questions/)
  assert.doesNotMatch(messageBody, /focused set of screening questions/)
  assert.doesNotMatch(messageBody, /recovery-token|setup\.example|raw_payload|stripe/i)
})

test('sendAlphaScreenWelcomeEmail sends without attachment when playbook file is missing', async () => {
  const originalApiKey = process.env.SENDGRID_API_KEY
  const sentMessages = []
  const warnings = []
  delete require.cache[mailerPath]
  delete require.cache[sendgridMailPath]
  injectModule(sendgridMailPath, {
    setApiKey() {},
    async send(message) {
      sentMessages.push(message)
      return [{ statusCode: 202 }]
    },
  })
  process.env.SENDGRID_API_KEY = 'test-key'
  try {
    const { sendAlphaScreenWelcomeEmail } = require(mailerPath)
    const result = await sendAlphaScreenWelcomeEmail(BUYER_EMAIL, {
      firstName: 'Alex',
      playbookAttachmentPath: path.join(os.tmpdir(), 'missing-alphascreen-playbook.pdf'),
      logger: {
        warn(message, metadata) {
          warnings.push({ message, metadata })
        }
      }
    })
    assert.equal(result.statusCode, 202)
  } finally {
    if (originalApiKey === undefined) delete process.env.SENDGRID_API_KEY
    else process.env.SENDGRID_API_KEY = originalApiKey
    delete require.cache[mailerPath]
    delete require.cache[sendgridMailPath]
  }

  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].attachments, undefined)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].message, '[mailer] alphascreen_welcome_playbook_attachment_missing')
  assert.deepEqual(warnings[0].metadata, {
    attachment_missing: true,
    filename: 'alphaScreen Getting Started Playbook.pdf',
    reason: 'not_found'
  })
  assert.doesNotMatch(JSON.stringify(warnings[0]), /alex@|setup|token|\/Users|missing-alphascreen-playbook/i)
})

test('checkout return state reports ready for an existing signed-in user', async () => {
  const db = makeDb('pro', 'annual')
  await activatePublicPurchaseAgreementCheckout({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL, last_sign_in_at: '2026-06-20T00:00:00Z' }]),
    agreementId: AGREEMENT_ID,
    checkoutSessionId: 'cs_test_public',
    paidAt: '2026-06-23T12:00:00.000Z',
    subscription: makeSubscription('annual'),
    requireParentClient: async () => ({ ok: true }),
    ensureRecovery: async () => {
      throw new Error('should_not_generate_recovery_for_existing_user')
    },
    sendRecoveryEmail: async () => {
      throw new Error('should_not_send_setup_email_for_existing_user')
    },
    sendWelcomeEmail: async () => ({ statusCode: 202 }),
    logger: { error() {}, warn() {} }
  })

  const readyStatus = await resolvePublicCheckoutReturnState({
    db,
    authAdmin: makeAuthAdmin([{ id: 'user-existing', email: BUYER_EMAIL, last_sign_in_at: '2026-06-20T00:00:00Z' }]),
    sessionId: 'cs_test_public',
    fallbackClientId: CLIENT_ID,
    agreementId: AGREEMENT_ID
  })

  assert.equal(readyStatus.status, 'ready')
})

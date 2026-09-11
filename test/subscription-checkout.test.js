'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const checkoutPath = path.join(__dirname, '..', 'src', 'services', 'subscriptionCheckout.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const clientBillingScopePath = path.join(__dirname, '..', 'src', 'services', 'clientBillingScope.js')
const urlConfigPath = path.join(__dirname, '..', 'src', 'config', 'urlConfig.js')
const stripePath = require.resolve('stripe')

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
    this.updatePayload = null
  }

  select() {
    return this
  }

  eq(column, value) {
    this.filters.push({ column, value })
    return this
  }

  order() {
    return this
  }

  update(payload) {
    this.updatePayload = payload
    return this
  }

  rows() {
    if (this.table === 'clients') return this.db.clients
    if (this.table === 'billing_customers') return this.db.billingCustomers
    return []
  }

  async maybeSingle() {
    return { data: this.rows().find((row) => matchesFilters(row, this.filters)) || null, error: null }
  }

  async execute() {
    if (this.updatePayload) {
      const rows = this.rows().filter((row) => matchesFilters(row, this.filters))
      for (const row of rows) Object.assign(row, this.updatePayload)
      this.db.updates.push({ table: this.table, payload: this.updatePayload, rows })
      return { data: rows, error: null }
    }
    return { data: this.rows().filter((row) => matchesFilters(row, this.filters)), error: null }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function makeDb() {
  const db = {
    clients: [{
      id: 'client-1',
      name: 'Acme Dental Group',
      email: 'alex@acmedental.example',
      client_admin_name: 'Alex Rivera',
      stripe_customer_id: 'cus_existing'
    }],
    billingCustomers: [{
      id: 'billing-customer-1',
      client_id: 'client-1',
      stripe_customer_id: 'cus_existing'
    }],
    updates: [],
    from(table) {
      return new FakeQuery(this, table)
    }
  }
  return db
}

function loadCheckout({ stripeCalls }) {
  delete require.cache[checkoutPath]
  delete require.cache[supabaseClientPath]
  delete require.cache[clientBillingScopePath]
  delete require.cache[urlConfigPath]
  delete require.cache[stripePath]

  injectModule(supabaseClientPath, { supabaseAdmin: makeDb() })
  injectModule(clientBillingScopePath, {
    requireParentClient: async () => ({ ok: true, clientId: 'client-1' })
  })
  injectModule(urlConfigPath, {
    resolvePublicBackendBase(value) {
      return value || 'https://api.qa.alphasourceai.com'
    },
    buildClientDashboardReturnUrl(query = {}) {
      const params = new URLSearchParams(query)
      return `https://qa.alphasourceai.com/dashboard?${params.toString()}`
    }
  })
  injectModule(stripePath, function Stripe() {
    return {
      customers: {
        retrieve: async (id) => ({ id }),
        update: async (id, payload) => {
          stripeCalls.customerUpdates.push({ id, payload })
          return { id, ...payload }
        },
        create: async (payload) => {
          stripeCalls.customerCreates.push(payload)
          return { id: 'cus_created', ...payload }
        }
      },
      subscriptions: {
        list: async (payload) => {
          stripeCalls.subscriptionLists.push(payload)
          return { data: [] }
        }
      },
      checkout: {
        sessions: {
          create: async (payload, options) => {
            stripeCalls.sessions.push({ payload, options })
            return { id: 'cs_test_subscription', url: 'https://checkout.stripe.test/cs_test_subscription' }
          }
        }
      }
    }
  })
  return require(checkoutPath)
}

test('subscription checkout adds configured one-time first-role prepay line item and metadata when selected', async () => {
  const previous = {
    STRIPE_PRICE_BASIC_MONTHLY: process.env.STRIPE_PRICE_BASIC_MONTHLY,
    STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY: process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  const stripeCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_basic_monthly'
  process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY = 'price_basic_first_role_prepay'
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    const result = await createSubscriptionCheckoutSession({
      clientId: 'client-1',
      planTier: 'Essential',
      billingInterval: 'monthly',
      metadataSource: 'agreement_checkout',
      metadata: {
        agreement_id: 'agreement-1',
        purchase_intent_id: 'intent-1'
      },
      firstRolePrepay: {
        selected: true,
        credit_type: 'first_role_prepay',
        amount_cents: 35900,
        normal_role_fee_cents: 39900,
        discount_percent: 10
      },
      idempotencyKey: 'agreement_checkout:agreement-1:basic:monthly',
      requestContext: {
        forwardedProto: 'https',
        forwardedHost: 'api.qa.alphasourceai.com'
      }
    })

    assert.equal(result.session.id, 'cs_test_subscription')
    assert.equal(stripeCalls.sessions.length, 1)
    const payload = stripeCalls.sessions[0].payload
    assert.deepEqual(payload.line_items, [
      { price: 'price_basic_monthly', quantity: 1 },
      { price: 'price_basic_first_role_prepay', quantity: 1 }
    ])
    assert.equal(payload.metadata.first_role_prepay_selected, 'true')
    assert.equal(payload.metadata.plan_tier, 'basic')
    assert.equal(payload.metadata.first_role_prepay_credit_type, 'first_role_prepay')
    assert.equal(payload.metadata.first_role_prepay_amount_cents, '35900')
    assert.equal(payload.metadata.first_role_prepay_normal_role_fee_cents, '39900')
    assert.equal(payload.metadata.first_role_prepay_discount_percent, '10')
    assert.equal(payload.subscription_data.metadata.first_role_prepay_amount_cents, '35900')
    assert.equal(payload.metadata.agreement_id, 'agreement-1')
    assert.equal(payload.metadata.purchase_intent_id, 'intent-1')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('subscription checkout fails selected first-role prepay when one-time Stripe price env is missing', async () => {
  const previous = {
    STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL,
    STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY: process.env.STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  }
  const stripeCalls = { sessions: [], customerUpdates: [], customerCreates: [], subscriptionLists: [] }
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual'
  delete process.env.STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    await assert.rejects(
      () => createSubscriptionCheckoutSession({
        clientId: 'client-1',
        planTier: 'pro',
        billingInterval: 'annual',
        metadataSource: 'agreement_checkout',
        firstRolePrepay: {
          selected: true,
          credit_type: 'first_role_prepay',
          amount_cents: 62900,
          normal_role_fee_cents: 69900,
          discount_percent: 10
        }
      }),
      /First-role prepay Stripe price is not configured/
    )
    assert.equal(stripeCalls.sessions.length, 0)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

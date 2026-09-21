'use strict'

// usage_interview_fee_cents on the Enterprise checkout.
//
// It is optional: leaving it out must behave exactly as before, so no existing
// Enterprise caller breaks. Supplying something unusable is a 400 rather than a
// silently dropped price. When supplied it rides the subscription metadata, which
// is where the webhook reads plan settings back from.
//
// Stripe, Supabase and the URL config are stubbed; no network.

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const checkoutPath = path.join(__dirname, '..', 'src', 'services', 'subscriptionCheckout.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
const clientBillingScopePath = path.join(__dirname, '..', 'src', 'services', 'clientBillingScope.js')
const urlConfigPath = path.join(__dirname, '..', 'src', 'config', 'urlConfig.js')
const stripePath = require.resolve('stripe')

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

function makeDb() {
  const query = {
    select() { return query },
    eq() { return query },
    order() { return query },
    update() { return query },
    async maybeSingle() {
      return {
        data: {
          id: 'client-1',
          name: 'Acme Dental Group',
          email: 'alex@acmedental.example',
          stripe_customer_id: 'cus_existing'
        },
        error: null
      }
    },
    then(resolve) { return resolve({ data: [], error: null }) }
  }
  return { from() { return query } }
}

function loadCheckout({ stripeCalls }) {
  for (const p of [checkoutPath, supabaseClientPath, clientBillingScopePath, urlConfigPath, stripePath]) {
    delete require.cache[p]
  }

  injectModule(supabaseClientPath, { supabaseAdmin: makeDb() })
  injectModule(clientBillingScopePath, {
    requireParentClient: async () => ({ ok: true, clientId: 'client-1' })
  })
  injectModule(urlConfigPath, {
    resolvePublicBackendBase(value) { return value || 'https://api.qa.alphasourceai.com' },
    buildClientDashboardReturnUrl(query = {}) {
      return `https://qa.alphasourceai.com/dashboard?${new URLSearchParams(query).toString()}`
    }
  })
  injectModule(stripePath, function Stripe() {
    return {
      customers: {
        retrieve: async (id) => ({ id }),
        update: async (id, payload) => ({ id, ...payload }),
        create: async (payload) => ({ id: 'cus_created', ...payload })
      },
      subscriptions: { list: async () => ({ data: [] }) },
      prices: {
        create: async (payload) => {
          stripeCalls.prices.push(payload)
          return { id: 'price_enterprise_created' }
        }
      },
      checkout: {
        sessions: {
          create: async (payload) => {
            stripeCalls.sessions.push(payload)
            return { id: 'cs_enterprise', url: 'https://checkout.stripe.test/cs_enterprise' }
          }
        }
      }
    }
  })
  return require(checkoutPath)
}

const BASE_FEES = Object.freeze({
  platform_fee: 1200,
  per_role_fee: 0,
  included_interviews_per_role: 0,
  additional_interview_fee: 0
})

async function enterpriseCheckout(enterpriseFees) {
  const stripeCalls = { sessions: [], prices: [] }
  const previousKey = process.env.STRIPE_SECRET_KEY
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout({ stripeCalls })
    const result = await createSubscriptionCheckoutSession({
      clientId: 'client-1',
      planTier: 'enterprise',
      billingInterval: 'monthly',
      metadataSource: 'admin_subscription_checkout',
      enterpriseFees,
      requestContext: { forwardedProto: 'https', forwardedHost: 'api.qa.alphasourceai.com' }
    })
    return { result, stripeCalls }
  } finally {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = previousKey
  }
}

test('an Enterprise checkout without a usage fee behaves exactly as before', async () => {
  const { result, stripeCalls } = await enterpriseCheckout({ ...BASE_FEES })

  assert.equal(result.session.id, 'cs_enterprise')
  assert.equal(stripeCalls.sessions.length, 1)
  const metadata = stripeCalls.sessions[0].metadata
  assert.equal(metadata.platform_fee, '1200')
  assert.equal(metadata.per_role_fee, '0')
  assert.equal(metadata.included_interviews_per_role, '0')
  assert.equal(metadata.additional_interview_fee, '0')
  assert.ok(!('usage_interview_fee_cents' in metadata),
    'an absent optional field must not appear in the metadata')
})

test('a supplied usage fee reaches both the price and the session metadata', async () => {
  const { stripeCalls } = await enterpriseCheckout({ ...BASE_FEES, usage_interview_fee_cents: 2500 })

  assert.equal(stripeCalls.sessions[0].metadata.usage_interview_fee_cents, '2500')
  assert.equal(stripeCalls.prices[0].metadata.usage_interview_fee_cents, '2500',
    'the webhook reads plan settings from the price metadata too')
})

test('a zero usage fee is a real price and is carried through', async () => {
  const { stripeCalls } = await enterpriseCheckout({ ...BASE_FEES, usage_interview_fee_cents: 0 })

  assert.equal(stripeCalls.sessions[0].metadata.usage_interview_fee_cents, '0')
})

test('a usage fee sent as a numeric string is accepted', async () => {
  const { stripeCalls } = await enterpriseCheckout({ ...BASE_FEES, usage_interview_fee_cents: '1750' })

  assert.equal(stripeCalls.sessions[0].metadata.usage_interview_fee_cents, '1750')
})

test('an unusable usage fee is refused rather than dropped', async () => {
  for (const bad of ['free', -100, 12.5, {}]) {
    await assert.rejects(
      () => enterpriseCheckout({ ...BASE_FEES, usage_interview_fee_cents: bad }),
      (err) => {
        assert.equal(err.status, 400)
        assert.equal(err.code, 'invalid_enterprise_fees')
        return true
      },
      `usage_interview_fee_cents ${JSON.stringify(bad)} should be refused`
    )
  }
})

test('the four required Enterprise fields are still required', async () => {
  await assert.rejects(
    () => enterpriseCheckout({ ...BASE_FEES, platform_fee: 0, usage_interview_fee_cents: 2500 }),
    (err) => {
      assert.equal(err.status, 400)
      assert.equal(err.code, 'invalid_enterprise_fees')
      return true
    }
  )
})

'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

const {
  buildAlphaScreenPlanSettingsPayload,
  buildAlphaScreenPackageSnapshot,
  getAlphaScreenPlatformFee,
  getAlphaScreenPlanSettingsDefaults,
  getAlphaScreenFirstRolePrepayStripePriceEnvName,
  getAlphaScreenFirstRolePrepayStripePriceId,
  getAlphaScreenStripePriceEnvName,
  getAlphaScreenStripePriceId,
  listPublicAlphaScreenPackages,
  normalizeAlphaScreenPlanKey
} = require('../src/services/alphaScreenPackages')

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'alphascreen', 'index.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
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

async function request(app, pathname) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
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

function buildApp() {
  delete require.cache[routePath]
  delete require.cache[supabaseClientPath]
  injectModule(supabaseClientPath, {
    supabaseAdmin: {
      from() {
        throw new Error('GET /packages should not access Supabase')
      }
    }
  })
  const router = require(routePath)
  const app = express()
  app.use('/api/alphascreen', router)
  return app
}

test('central package config returns canonical Essential and Pro values', () => {
  assert.equal(normalizeAlphaScreenPlanKey('essential'), 'basic')
  assert.equal(normalizeAlphaScreenPlanKey('Basic'), 'basic')
  assert.deepEqual(getAlphaScreenPlanSettingsDefaults('basic'), {
    per_role_fee: 399,
    included_interviews_per_role: 20,
    additional_interview_fee: 30,
    max_interview_minutes: 10
  })
  assert.equal(getAlphaScreenPlatformFee('basic', 'monthly'), 299)
  assert.equal(getAlphaScreenPlatformFee('basic', 'annual'), 3299)
  assert.equal(buildAlphaScreenPackageSnapshot('basic', 'monthly').first_role_prepay.discounted_credit_amount_cents, 35900)
  assert.equal(buildAlphaScreenPackageSnapshot('basic', 'monthly').first_role_prepay.normal_role_fee_cents, 39900)
  assert.deepEqual(getAlphaScreenPlanSettingsDefaults('pro'), {
    per_role_fee: 699,
    included_interviews_per_role: 30,
    additional_interview_fee: 35,
    max_interview_minutes: 12
  })
  assert.equal(getAlphaScreenPlatformFee('pro', 'monthly'), 599)
  assert.equal(getAlphaScreenPlatformFee('pro', 'annual'), 6499)
  assert.equal(buildAlphaScreenPackageSnapshot('pro', 'monthly').first_role_prepay.discounted_credit_amount_cents, 62900)
  assert.equal(buildAlphaScreenPackageSnapshot('pro', 'monthly').first_role_prepay.normal_role_fee_cents, 69900)
})

test('webhook Essential provisioning payload uses 20 interviews, 10 minutes, and $30 overage', () => {
  const payload = buildAlphaScreenPlanSettingsPayload({
    clientId: 'client-basic',
    planKey: 'basic',
    billingInterval: 'monthly'
  })

  assert.deepEqual(payload, {
    client_id: 'client-basic',
    plan_tier: 'basic',
    billing_interval: 'monthly',
    platform_fee: 299,
    per_role_fee: 399,
    included_interviews_per_role: 20,
    additional_interview_fee: 30,
    max_interview_minutes: 10
  })
})

test('webhook Pro provisioning payload uses 30 interviews, 12 minutes, and $35 overage', () => {
  const payload = buildAlphaScreenPlanSettingsPayload({
    clientId: 'client-pro',
    planKey: 'pro',
    billingInterval: 'annual'
  })

  assert.deepEqual(payload, {
    client_id: 'client-pro',
    plan_tier: 'pro',
    billing_interval: 'annual',
    platform_fee: 6499,
    per_role_fee: 699,
    included_interviews_per_role: 30,
    additional_interview_fee: 35,
    max_interview_minutes: 12
  })
})

test('central package config defines Stripe price env var names without reading secrets', () => {
  assert.equal(getAlphaScreenStripePriceEnvName('basic', 'monthly'), 'STRIPE_PRICE_BASIC_MONTHLY')
  assert.equal(getAlphaScreenStripePriceEnvName('basic', 'annual'), 'STRIPE_PRICE_BASIC_ANNUAL')
  assert.equal(getAlphaScreenStripePriceEnvName('pro', 'monthly'), 'STRIPE_PRICE_PRO_MONTHLY')
  assert.equal(getAlphaScreenStripePriceEnvName('pro', 'annual'), 'STRIPE_PRICE_PRO_ANNUAL')
  assert.equal(getAlphaScreenFirstRolePrepayStripePriceEnvName('basic'), 'STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY')
  assert.equal(getAlphaScreenFirstRolePrepayStripePriceEnvName('pro'), 'STRIPE_PRICE_PRO_FIRST_ROLE_PREPAY')
  assert.equal(getAlphaScreenStripePriceId('basic', 'monthly', { STRIPE_PRICE_BASIC_MONTHLY: 'price_test_basic_monthly' }), 'price_test_basic_monthly')
  assert.equal(getAlphaScreenFirstRolePrepayStripePriceId('basic', { STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY: 'price_test_basic_first_role' }), 'price_test_basic_first_role')
})

test('central package snapshot includes public package values and no Stripe price ids', () => {
  const snapshot = buildAlphaScreenPackageSnapshot('pro', 'annual')

  assert.equal(snapshot.plan_key, 'pro')
  assert.equal(snapshot.billing_cadence, 'annual')
  assert.equal(snapshot.platform_fee, 6499)
  assert.equal(snapshot.platform_fee_cents, 649900)
  assert.equal(snapshot.platform_fee_billing_cadence, 'annual')
  assert.equal(snapshot.platform_monthly_fee, 599)
  assert.equal(snapshot.platform_annual_fee, 6499)
  assert.equal(snapshot.annual_platform_fee_note, 'Discounted annual platform fee')
  assert.equal(snapshot.included_interviews, 30)
  assert.equal(snapshot.max_interview_minutes, 12)
  assert.equal(snapshot.additional_interview_fee, 35)
  assert.equal(snapshot.per_role_fee, 699)
  assert.deepEqual(snapshot.first_role_prepay, {
    enabled: true,
    credit_type: 'first_role_prepay',
    normal_role_fee_cents: 69900,
    discounted_credit_amount_cents: 62900,
    discount_percent: 10,
    non_refundable: true,
    expires: false,
    selected: false
  })
  assert.doesNotMatch(JSON.stringify(snapshot), /STRIPE_PRICE_|price_test|price_live|sk_test|sk_live/)
  assertNoStaleAnnualPricingPayload(snapshot)
})

test('public package endpoint exposes safe package data and no Stripe secrets', async () => {
  const previousBasicMonthly = process.env.STRIPE_PRICE_BASIC_MONTHLY
  const previousBasicFirstRole = process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY
  const previousProAnnual = process.env.STRIPE_PRICE_PRO_ANNUAL
  process.env.STRIPE_PRICE_BASIC_MONTHLY = 'price_test_basic_monthly_secret_value'
  process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY = 'price_test_basic_first_role_secret_value'
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_test_pro_annual_secret_value'
  try {
    const response = await request(buildApp(), '/api/alphascreen/packages')
    assert.equal(response.status, 200)
    assert.equal(Array.isArray(response.body.packages), true)
    assert.equal(response.body.packages.length, 2)

    const basic = response.body.packages.find((item) => item.plan_key === 'basic')
    const pro = response.body.packages.find((item) => item.plan_key === 'pro')
    assert.equal(basic.platform_monthly_fee, 299)
    assert.equal(basic.platform_monthly_fee_cents, 29900)
    assert.equal(basic.platform_annual_fee, 3299)
    assert.equal(basic.platform_annual_fee_cents, 329900)
    assert.equal(basic.annual_platform_fee_note, 'Discounted annual platform fee')
    assert.equal(basic.per_role_fee, 399)
    assert.equal(basic.first_role_prepay.enabled, true)
    assert.equal(basic.first_role_prepay.selected, false)
    assert.equal(basic.first_role_prepay.discounted_credit_amount_cents, 35900)
    assert.equal(basic.first_role_prepay.normal_role_fee_cents, 39900)
    assert.equal(basic.first_role_prepay.discount_percent, 10)
    assert.equal(basic.first_role_prepay.stripe_price_configured, true)
    assert.equal(basic.included_interviews, 20)
    assert.equal(basic.interview_duration_minutes, 10)
    assert.equal(basic.scored_question_count, 5)
    assert.equal(basic.overage_price, 30)
    assert.equal(pro.platform_monthly_fee, 599)
    assert.equal(pro.platform_monthly_fee_cents, 59900)
    assert.equal(pro.platform_annual_fee, 6499)
    assert.equal(pro.platform_annual_fee_cents, 649900)
    assert.equal(pro.annual_platform_fee_note, 'Discounted annual platform fee')
    assert.equal(pro.per_role_fee, 699)
    assert.equal(pro.first_role_prepay.discounted_credit_amount_cents, 62900)
    assert.equal(pro.first_role_prepay.normal_role_fee_cents, 69900)
    assert.equal(pro.included_interviews, 30)
    assert.equal(pro.interview_duration_minutes, 12)
    assert.equal(pro.scored_question_count, 6)
    assert.equal(pro.overage_price, 35)

    const basicMonthly = basic.billing_cadences.find((item) => item.key === 'monthly')
    const proAnnual = pro.billing_cadences.find((item) => item.key === 'annual')
    assert.equal(basicMonthly.stripe_price_configured, true)
    assert.equal(proAnnual.stripe_price_configured, true)

    const serialized = JSON.stringify(response.body)
    assert.doesNotMatch(serialized, /price_test_basic_monthly_secret_value/)
    assert.doesNotMatch(serialized, /price_test_basic_first_role_secret_value/)
    assert.doesNotMatch(serialized, /price_test_pro_annual_secret_value/)
    assert.doesNotMatch(serialized, /STRIPE_SECRET|sk_live|sk_test/)
    assertNoStaleAnnualPricingPayload(basic)
    assertNoStaleAnnualPricingPayload(pro)
  } finally {
    if (previousBasicMonthly === undefined) delete process.env.STRIPE_PRICE_BASIC_MONTHLY
    else process.env.STRIPE_PRICE_BASIC_MONTHLY = previousBasicMonthly
    if (previousBasicFirstRole === undefined) delete process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY
    else process.env.STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY = previousBasicFirstRole
    if (previousProAnnual === undefined) delete process.env.STRIPE_PRICE_PRO_ANNUAL
    else process.env.STRIPE_PRICE_PRO_ANNUAL = previousProAnnual
  }
})

test('public package listing exposes price configuration flags, not price id values', () => {
  const packages = listPublicAlphaScreenPackages({
    env: {
      STRIPE_PRICE_BASIC_MONTHLY: 'price_test_basic_monthly',
      STRIPE_PRICE_BASIC_FIRST_ROLE_PREPAY: 'price_test_basic_first_role',
      STRIPE_PRICE_PRO_MONTHLY: ''
    }
  })
  const basic = packages.find((item) => item.plan_key === 'basic')
  const pro = packages.find((item) => item.plan_key === 'pro')

  assert.equal(basic.billing_cadences.find((item) => item.key === 'monthly').stripe_price_configured, true)
  assert.equal(basic.first_role_prepay.stripe_price_configured, true)
  assert.equal(pro.billing_cadences.find((item) => item.key === 'monthly').stripe_price_configured, false)
  assert.equal(pro.first_role_prepay.stripe_price_configured, false)
  assert.doesNotMatch(JSON.stringify(packages), /price_test_basic_monthly|price_test_basic_first_role|STRIPE_PRICE_/)
})

test('public package listing keeps platform fees distinct from per-role fees', () => {
  const packages = listPublicAlphaScreenPackages()
  const basic = packages.find((item) => item.plan_key === 'basic')
  const pro = packages.find((item) => item.plan_key === 'pro')

  assert.equal(basic.platform_monthly_fee, 299)
  assert.equal(basic.per_role_fee, 399)
  assert.notEqual(basic.platform_monthly_fee, basic.per_role_fee)
  assert.equal(pro.platform_monthly_fee, 599)
  assert.equal(pro.per_role_fee, 699)
  assert.notEqual(pro.platform_monthly_fee, pro.per_role_fee)
})

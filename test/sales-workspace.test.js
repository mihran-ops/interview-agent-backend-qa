'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  agreementInputFromDraft,
  agreementSchedule,
  calculatePricing,
  deriveDealStatus,
  fingerprint,
  normalizeSalesDraft,
  validateSalesDraft
} = require('../src/services/salesWorkspace')
const { buildMembershipAgreementHtml } = require('../src/render/membershipAgreement')

function validDraft(overrides = {}) {
  return normalizeSalesDraft({
    company_legal_name: '  Acme Dental Group LLC ',
    buyer_first_name: 'Alex',
    buyer_last_name: 'Rivera',
    buyer_email: ' ALEX@ACME.EXAMPLE ',
    buyer_phone: '720-555-0100',
    buyer_title: 'Owner',
    candidate_assistance_name: 'Alex Rivera',
    candidate_assistance_email: 'alex@acme.example',
    plan_key: 'Essential',
    billing_cadence: 'annual',
    first_role_prepay_selected: true,
    ...overrides
  })
}

test('sales draft normalizes canonical membership values and rejects Enterprise', () => {
  const draft = validateSalesDraft(validDraft())
  assert.equal(draft.company_legal_name, 'Acme Dental Group LLC')
  assert.equal(draft.buyer_email, 'alex@acme.example')
  assert.equal(draft.plan_key, 'basic')
  assert.equal(draft.billing_cadence, 'annual')

  assert.throws(
    () => validateSalesDraft(validDraft({ plan_key: 'enterprise' })),
    (error) => error.code === 'invalid_sales_draft' && Boolean(error.fields?.plan_key)
  )
})

test('sales pricing applies an approved promotion only to the platform fee', () => {
  const draft = validDraft()
  const result = calculatePricing(draft, {
    code: 'SAVE10',
    promotion_code_id: 'promo_123',
    label: '10% off',
    percent_off: 10
  })
  assert.equal(result.pricing.platform_fee_cents, 329900)
  assert.equal(result.pricing.first_role_prepay_cents, 35900)
  assert.equal(result.pricing.promotion_discount_cents, 32990)
  assert.equal(result.pricing.initial_payment_cents, 332810)
})

test('sales agreements use concrete Denver dates and clamp leap-day renewal', () => {
  const draft = validDraft({ first_role_prepay_selected: false })
  const { package_snapshot: packageSnapshot } = calculatePricing(draft)
  const schedule = agreementSchedule('2028-02-29T19:00:00.000Z')
  const agreement = agreementInputFromDraft(draft, packageSnapshot, schedule)
  assert.equal(agreement.term_start_basis, 'agreement_date')
  assert.equal(agreement.initial_term_start, '2028-02-29')
  assert.equal(agreement.initial_renewal_date, '2029-02-28')
  assert.equal(schedule.expires_at, '2028-03-01T07:00:00.000Z')
  const rendered = buildMembershipAgreementHtml(agreement, {
    showPackageTerms: true,
    generatedAt: '2028-02-29T19:00:00.000Z',
    timeZone: 'America/Denver'
  }).html
  assert.match(rendered, /February 29, 2028/)
  assert.match(rendered, /February 28, 2029/)
  assert.match(rendered, /Signature and initial payment deadline/)
  assert.doesNotMatch(rendered, /Successful initial payment date|One year after initial payment|successful payment date controls/i)
})

test('deal status reflects signature, payment, activation, and cancellation states', () => {
  assert.equal(deriveDealStatus({ status: 'agreement_pending' }, { status: 'sent' }), 'agreement_sent')
  assert.equal(deriveDealStatus({ status: 'agreement_pending' }, { status: 'signed' }), 'signed_payment_needed')
  assert.equal(deriveDealStatus({ status: 'checkout_pending' }, { status: 'signed', checkout_status: 'pending_payment' }), 'checkout_in_progress')
  assert.equal(deriveDealStatus({ status: 'completed' }, { checkout_status: 'paid' }), 'activated')
  assert.equal(deriveDealStatus({ status: 'canceled' }, { status: 'voided' }), 'canceled')
  assert.equal(deriveDealStatus(
    { status: 'agreement_pending' },
    { status: 'signed', agreement_expires_at: '2026-09-19T06:00:00.000Z' },
    new Date('2026-09-19T06:00:00.000Z')
  ), 'expired')
  assert.equal(deriveDealStatus(
    { status: 'completed', activated_at: '2026-09-19T05:59:00.000Z' },
    { status: 'signed', checkout_status: 'paid', agreement_expires_at: '2026-09-19T06:00:00.000Z' },
    new Date('2026-09-20T06:00:00.000Z')
  ), 'activated')
})

test('fingerprint is stable across object key order', () => {
  assert.equal(fingerprint({ a: 1, b: { c: 2 } }), fingerprint({ b: { c: 2 }, a: 1 }))
})

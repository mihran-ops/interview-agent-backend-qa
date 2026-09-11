'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { buildMembershipAgreementHtml } = require('../src/render/membershipAgreement')

const baseAgreement = {
  client_legal_name: 'Acme Dental Group',
  dba_trade_name: 'Acme Dental',
  primary_admin_name: 'Alex Rivera',
  admin_email: 'alex@acmedental.example',
  membership_tier: 'basic',
  initial_term_start: '2026-06-24',
  initial_renewal_date: '2027-06-24',
  billing_option: 'monthly',
  auto_renew: true,
  notice_deadline_days: 30
}

test('Essential is the display label while basic remains the canonical agreement key', () => {
  const { html, normalized } = buildMembershipAgreementHtml(baseAgreement)

  assert.equal(normalized.membership_tier, 'basic')
  assert.match(html, /Membership Tier/)
  assert.match(html, />Essential</)
  assert.doesNotMatch(html, />Basic</)
})

test('admin-created agreement rendering does not show public purchase package fields by default', () => {
  const { html } = buildMembershipAgreementHtml(baseAgreement)

  assert.doesNotMatch(html, /Platform Fee/)
  assert.doesNotMatch(html, /Per-Role Fee/)
  assert.doesNotMatch(html, /Included Interviews/)
  assert.doesNotMatch(html, /Interview Duration Cap/)
  assert.doesNotMatch(html, /Additional Interview Fee/)
})

test('public purchase agreement rendering includes package fields when explicitly enabled', () => {
  const { html } = buildMembershipAgreementHtml({
    ...baseAgreement,
    platform_fee: 299,
    per_role_fee: 399,
    included_interviews_per_role: 20,
    max_interview_minutes: 10,
    additional_interview_fee: 30
  }, { showPackageTerms: true })

  assert.match(html, /Platform Fee/)
  assert.match(html, /Per-Role Fee/)
  assert.match(html, /Included Interviews/)
  assert.match(html, /Interview Duration Cap/)
  assert.match(html, /Additional Interview Fee/)
  assert.match(html, /\$299\.00/)
  assert.match(html, /\$399\.00/)
  assert.match(html, /\$30\.00/)
  assert.match(html, />20</)
  assert.match(html, />10 Minutes</)
})

test('executed public purchase agreement keeps package fields and signature state', () => {
  const { html } = buildMembershipAgreementHtml({
    ...baseAgreement,
    platform_fee: 599,
    per_role_fee: 699,
    included_interviews_per_role: 30,
    max_interview_minutes: 12,
    additional_interview_fee: 35
  }, {
    showPackageTerms: true,
    execution: {
      accepted: true,
      signer_typed_name: 'Alex Rivera',
      signed_at: '2026-06-24T12:00:00.000Z'
    }
  })

  assert.match(html, /Platform Fee/)
  assert.match(html, /Included Interviews/)
  assert.match(html, /Alex Rivera/)
  assert.match(html, /Signed on/)
})

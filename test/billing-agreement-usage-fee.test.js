'use strict';

// usage_interview_fee_cents on a membership agreement.
//
// Enterprise pricing set on the admin Agreement Generator becomes a client's plan
// settings only after the client pays, by way of template_snapshot.values →
// buildAgreementInputFromRow → the public checkout → Stripe metadata → the
// webhook. The first version of Billing 1 wired the checkout end but not the
// normalizer, so the price was dropped before it was ever stored. These tests pin
// the two ends the normalizer sits between.
//
// Pure functions; no database, no network.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} }
};

const { normalizeMembershipAgreementInput } = require(path.join(ROOT, 'src', 'render', 'membershipAgreement.js'));
const { buildAgreementInputFromRow } = require(path.join(ROOT, 'src', 'services', 'membershipAgreements', 'index.js'));

const ENTERPRISE = Object.freeze({
  client_legal_name: 'Acme Dental Group',
  primary_admin_name: 'Alex Rivera',
  admin_email: 'alex@acmedental.example',
  membership_tier: 'enterprise',
  billing_option: 'monthly',
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '5',
  additional_interview_fee: '0',
  initial_term_start: '2026-10-01',
  initial_renewal_date: '2027-10-01'
});

test('a usage price on the agreement is normalised to whole cents', () => {
  const normalized = normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '2500' });
  assert.equal(normalized.usage_interview_fee_cents, 2500);
});

test('the camel-case key the admin form may send is accepted too', () => {
  const normalized = normalizeMembershipAgreementInput({ ...ENTERPRISE, usageInterviewFeeCents: 1750 });
  assert.equal(normalized.usage_interview_fee_cents, 1750);
});

test('a zero-cent usage price is kept as a price, not read as absent', () => {
  assert.equal(normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: 0 }).usage_interview_fee_cents, 0);
  assert.equal(normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '0' }).usage_interview_fee_cents, 0);
});

test('an absent usage price is null, so nothing downstream mistakes it for a price', () => {
  assert.equal(normalizeMembershipAgreementInput({ ...ENTERPRISE }).usage_interview_fee_cents, null);
  assert.equal(normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '' }).usage_interview_fee_cents, null);
});

test('a negative or unparseable usage price is refused rather than stored', () => {
  for (const bad of ['-100', 'free', '12.5.1']) {
    assert.equal(
      normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: bad }).usage_interview_fee_cents,
      null,
      `${JSON.stringify(bad)} must not become a price`
    );
  }
});

test('a fractional cent value is rounded, matching the other cents inputs', () => {
  assert.equal(normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '2499.6' }).usage_interview_fee_cents, 2500);
});

test('the price survives the round trip through the stored snapshot', () => {
  // This is the path the public checkout reads: the agreement row's
  // template_snapshot.values, written at send time and read back at pay time.
  const stored = normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '2500' });
  const row = { id: 'agr_1', client_id: 'client_1', template_snapshot: { values: stored } };

  const agreementInput = buildAgreementInputFromRow(row);

  assert.equal(agreementInput.usage_interview_fee_cents, 2500);
  assert.equal(agreementInput.membership_tier, 'enterprise');
  assert.equal(agreementInput.platform_fee, '1200', 'the other Enterprise fees still travel the same way');
});

test('an agreement sent before the field existed reads back as no usage price', () => {
  const legacySnapshot = { ...ENTERPRISE };
  const row = { id: 'agr_old', client_id: 'client_1', template_snapshot: { values: legacySnapshot } };

  assert.equal(buildAgreementInputFromRow(row).usage_interview_fee_cents, null);
});

test('the other Enterprise fields are unchanged by the addition', () => {
  const normalized = normalizeMembershipAgreementInput({ ...ENTERPRISE, usage_interview_fee_cents: '2500' });
  assert.equal(normalized.platform_fee, '1200');
  assert.equal(normalized.per_role_fee, '0');
  assert.equal(normalized.included_interviews_per_role, '5');
  assert.equal(normalized.additional_interview_fee, '0');
});

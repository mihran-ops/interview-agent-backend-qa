'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { promotionEligibilityError, replacementCheckoutDisposition } = require('../src/routes/sales')
const {
  shouldApplyGenericSubscriptionUpdate,
  claimAgreementPurchaseActivation,
  markAgreementCheckoutPaid
} = require('../src/routes/webhooks/stripe')
const { buildExecutedMembershipAgreementHtml } = require('../src/routes/public/membershipAgreements/signing')

test('sales promotion validation rejects restrictions that cannot be honored before checkout', () => {
  const pricing = { platform_fee_cents: 29900, first_role_prepay_cents: 0 }
  assert.match(
    promotionEligibilityError({ restrictions: { first_time_transaction: true } }, pricing),
    /customer history/i
  )
  assert.match(
    promotionEligibilityError({ restrictions: { minimum_amount: 40000, minimum_amount_currency: 'usd' } }, pricing),
    /minimum/i
  )
  assert.match(
    promotionEligibilityError({ coupon: { applies_to: { products: ['prod_restricted'] } } }, pricing),
    /product-restricted/i
  )
  assert.match(
    promotionEligibilityError({ coupon: { amount_off: 1000, currency: 'eur' } }, pricing),
    /USD/i
  )
  assert.equal(promotionEligibilityError({ restrictions: {} }, pricing), '')
})

test('expired agreement replacement refuses completed or paid Stripe sessions', () => {
  assert.equal(replacementCheckoutDisposition({ status: 'complete', payment_status: 'unpaid' }), 'paid')
  assert.equal(replacementCheckoutDisposition({ status: 'open', payment_status: 'paid' }), 'paid')
  assert.equal(replacementCheckoutDisposition({ status: 'open', payment_status: 'unpaid' }), 'open')
  assert.equal(replacementCheckoutDisposition({ status: 'expired', payment_status: 'unpaid' }), 'expired')
  assert.equal(replacementCheckoutDisposition(null), 'missing')
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sales', 'index.js'), 'utf8')
  assert.match(source, /checkout\.sessions\.retrieve\(checkoutSessionId\)/)
  assert.match(source, /agreement_already_paid/)
  assert.match(source, /replace_sales_assisted_agreement/)
})

test('sales migration prevents preview reuse and concurrent active buyer duplicates', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260918195401_sales_workspace.sql'), 'utf8')
  assert.match(sql, /add column if not exists sales_preview_id uuid references public\.sales_deal_previews\(id\)/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_sales_preview_uidx/i)
  assert.match(sql, /create unique index if not exists public_purchase_intents_active_sales_buyer_uidx[\s\S]*lower\(buyer_email\)[\s\S]*channel = 'sales_assisted'/i)
  assert.match(sql, /alter column initial_term_start drop not null[\s\S]*alter column initial_renewal_date drop not null/i)
  assert.match(sql, /sales_preview_id uuid references public\.sales_deal_previews\(id\) on delete restrict/i)
  assert.match(sql, /add column if not exists activation_claimed_at timestamptz/i)
  assert.match(sql, /add column if not exists activation_claim_key text/i)
})

function activationClaimDb(intent, options = {}) {
  const state = { intent: intent ? { ...intent } : null }
  return {
    state,
    from() {
      const query = {
        action: 'select',
        payload: null,
        filters: [],
        select() { return this },
        update(payload) { this.action = 'update'; this.payload = payload; return this },
        eq(column, value) { this.filters.push({ op: 'eq', column, value }); return this },
        neq(column, value) { this.filters.push({ op: 'neq', column, value }); return this },
        is(column, value) { this.filters.push({ op: 'is', column, value }); return this },
        async maybeSingle() {
          const matches = state.intent && this.filters.every(({ op, column, value }) => {
            if (op === 'is') return value === null ? state.intent[column] == null : state.intent[column] === value
            if (op === 'neq') return String(state.intent[column] ?? '') !== String(value ?? '')
            return String(state.intent[column] ?? '') === String(value ?? '')
          })
          if (this.action === 'update' && options.beforeClaim) options.beforeClaim(state)
          const stillMatches = state.intent && this.filters.every(({ op, column, value }) => {
            if (op === 'is') return value === null ? state.intent[column] == null : state.intent[column] === value
            if (op === 'neq') return String(state.intent[column] ?? '') !== String(value ?? '')
            return String(state.intent[column] ?? '') === String(value ?? '')
          })
          if (!matches || !stillMatches) return { data: null, error: null }
          if (this.action === 'update') Object.assign(state.intent, this.payload)
          return { data: state.intent ? { ...state.intent } : null, error: null }
        }
      }
      return query
    }
  }
}

test('payment activation atomically claims an open sales intent', async () => {
  const db = activationClaimDb({
    id: 'intent-1',
    agreement_id: 'agreement-1',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  })
  const claim = await claimAgreementPurchaseActivation('agreement-1', 'cs_1', db)
  assert.deepEqual(claim, { proceed: true, claimed: true, intentId: 'intent-1', key: 'cs_1' })
  assert.equal(db.state.intent.activation_claim_key, 'cs_1')
  assert.ok(db.state.intent.activation_claimed_at)
})

test('payment activation loses to a concurrent cancellation without reactivating it', async () => {
  const db = activationClaimDb({
    id: 'intent-2',
    agreement_id: 'agreement-2',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  }, {
    beforeClaim(state) {
      state.intent.status = 'canceled'
      state.intent.canceled_at = '2026-09-18T21:00:00.000Z'
    }
  })
  const claim = await claimAgreementPurchaseActivation('agreement-2', 'cs_2', db)
  assert.deepEqual(claim, {
    proceed: false,
    result: { ok: false, status: 'purchase_canceled', purchase_intent_id: 'intent-2' }
  })
  assert.equal(db.state.intent.activation_claimed_at, null)
})

test('payment activation loses safely when agreement replacement moves the intent during the claim', async () => {
  const db = activationClaimDb({
    id: 'intent-3',
    agreement_id: 'agreement-old',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  }, {
    beforeClaim(state) {
      state.intent.agreement_id = 'agreement-new'
    }
  })
  const claim = await claimAgreementPurchaseActivation('agreement-old', 'cs_old', db)
  assert.deepEqual(claim, {
    proceed: false,
    result: { ok: false, status: 'agreement_superseded', purchase_intent_id: 'intent-3' }
  })
  assert.equal(db.state.intent.activation_claimed_at, null)
})

test('non-ok activation releases its exact purchase claim for a legitimate retry', async () => {
  const db = activationClaimDb({
    id: 'intent-4',
    agreement_id: 'agreement-4',
    status: 'checkout_pending',
    activated_at: null,
    canceled_at: null,
    activation_claimed_at: null,
    activation_claim_key: null
  })
  const result = await markAgreementCheckoutPaid('agreement-4', {
    checkoutSessionId: 'cs_4',
    db,
    activate: async () => ({ ok: false, status: 'agreement_superseded' })
  })
  assert.deepEqual(result, { ok: false, status: 'agreement_superseded' })
  assert.equal(db.state.intent.activation_claimed_at, null)
  assert.equal(db.state.intent.activation_claim_key, null)
})

test('signed agreement render uses the stored deadline in Denver regardless of host timezone', () => {
  const { html } = buildExecutedMembershipAgreementHtml({
    client_legal_name: 'Acme Dental Group',
    primary_admin_name: 'Alex Rivera',
    admin_email: 'alex@example.com',
    membership_tier: 'basic',
    initial_term_start: '2026-09-19',
    initial_renewal_date: '2027-09-19',
    agreement_expires_at: '2026-09-20T06:00:00.000Z',
    billing_option: 'annual',
    auto_renew: true,
    notice_deadline_days: 30,
    template_snapshot: { source: 'sales_assisted' }
  }, {
    accepted: true,
    signer_typed_name: 'Alex Rivera',
    signed_at: '2026-09-19T20:00:00.000Z'
  })
  assert.match(html, /Signature and initial payment deadline/)
  assert.match(html, /September 19, 2026 at 11:59 PM MDT/)
  assert.doesNotMatch(html, /September 20, 2026 at 6:59 AM/)
})

test('agreement checkout webhooks do not fall through to generic client activation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8')
  assert.match(source, /if \(!isPaidAgreementCheckout\) \{[\s\S]*buildClientSubscriptionUpdatesFromStripe/i)
  assert.match(source, /const isAgreementCheckoutInvoice =[\s\S]*metadataSource === 'agreement_checkout'/i)
  assert.match(source, /customerId && !isManagedSubscriptionInvoice && !isAgreementCheckoutInvoice/i)
})

test('generic subscription webhooks wait for guarded agreement-checkout activation', async () => {
  const dbFor = (intent) => ({
    from() {
      return {
        select() { return this },
        eq() { return this },
        async maybeSingle() { return { data: intent, error: null } }
      }
    }
  })
  const metadata = { source: 'agreement_checkout', agreement_id: 'agreement-1' }
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'checkout_pending', activated_at: null, canceled_at: null })), false)
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'canceled', activated_at: null, canceled_at: '2026-09-18T20:00:00.000Z' })), false)
  assert.equal(await shouldApplyGenericSubscriptionUpdate(metadata, dbFor({ status: 'completed', activated_at: '2026-09-18T20:01:00.000Z', canceled_at: null })), true)
  assert.equal(await shouldApplyGenericSubscriptionUpdate({ source: 'admin_subscription_checkout' }, dbFor(null)), true)
})

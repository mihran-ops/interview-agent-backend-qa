'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { createFakeSmsProvider } = require('../src/services/smsFakeProvider')
const {
  RETAIL_SMS_CONSENT_COPY_VERSION,
  consumeRetailSignupSmsOtp,
  deliverRetailSignupSmsOtp,
  loadRetailSmsVerificationState,
  normalizeRetailPhone,
  readRetailSmsConfiguration,
  retailSmsVerifierHmac,
} = require('../src/services/retailSmsVerification')

const INTENT_ID = '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a184'
const OTP_SECRET = 'retail-sms-test-secret-that-is-at-least-thirty-two-bytes'
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260827123000_retail_signup_sms_verification.sql')
const RESEND_COOLDOWN_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260828163805_extend_retail_sms_resend_cooldown.sql')

function localEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_ENABLED: 'true',
    SMS_RETAIL_UI_ENABLED: 'true',
    SMS_CONSENT_COPY_VERSION: RETAIL_SMS_CONSENT_COPY_VERSION,
    SMS_FAKE_MODE: 'accepted',
    OTP_HMAC_SECRET_VERSION: '1',
    OTP_HMAC_SECRET_V1: OTP_SECRET,
    ...overrides,
  }
}

function intent(overrides = {}) {
  return {
    id: INTENT_ID,
    status: 'pending',
    selected_plan_key: 'basic',
    selected_billing_cadence: 'annual',
    buyer_phone: '+1 (555) 555-0184',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  }
}

function makeDb() {
  const state = {
    issued: null,
    metadata: [],
    invalidations: [],
    consumed: false,
  }
  return {
    state,
    async rpc(name, args) {
      if (name === 'service_issue_retail_signup_sms_verification') {
        state.issued = { ...args, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
        return {
          data: [{
            status: 'issued',
            verification_id: args.p_verification_id,
            expires_at: state.issued.expires_at,
            resend_after_seconds: 120,
          }],
          error: null,
        }
      }
      if (name === 'service_record_retail_signup_sms_delivery_metadata') {
        state.metadata.push({ ...args })
        return { data: true, error: null }
      }
      if (name === 'service_invalidate_retail_signup_sms_verifications') {
        state.invalidations.push({ ...args })
        return { data: 1, error: null }
      }
      if (name === 'service_get_retail_signup_sms_verification') {
        if (!state.issued) return { data: [], error: null }
        return {
          data: [{
            verification_id: state.issued.p_verification_id,
            verifier_hmac_hex: state.issued.p_verifier_hmac_hex,
            verified: state.consumed,
            status: state.consumed ? 'verified' : 'code_sent',
            expires_at: state.issued.expires_at,
            sent_at: new Date().toISOString(),
            resend_after_seconds: 120,
          }],
          error: null,
        }
      }
      if (name === 'service_consume_retail_signup_sms_verification') {
        assert.equal(args.p_verification_id, state.issued.p_verification_id)
        assert.equal(typeof args.p_verifier_matches, 'boolean')
        const valid = args.p_verifier_matches === true
        state.consumed = valid
        return { data: [{ status: valid ? 'verified' : 'invalid' }], error: null }
      }
      if (name === 'service_is_sms_destination_suppressed') return { data: false, error: null }
      throw new Error(`Unexpected RPC ${name}`)
    },
  }
}

test('retail SMS configuration is separately gated and accepts only the approved consent version', () => {
  assert.equal(readRetailSmsConfiguration(localEnv()).valid, true)
  assert.equal(readRetailSmsConfiguration(localEnv({ SMS_RETAIL_UI_ENABLED: 'false' })).valid, false)
  assert.equal(readRetailSmsConfiguration(localEnv({ SMS_CONSENT_COPY_VERSION: 'old-copy' })).valid, false)
  assert.equal(readRetailSmsConfiguration(localEnv({ SMS_PROVIDER: 'telnyx' })).valid, false)
})

test('retail phone normalization is U.S.-only and canonical', () => {
  assert.equal(normalizeRetailPhone('(555) 555-0184').phone_e164, '+15555550184')
  assert.equal(normalizeRetailPhone('+1 555 555 0184').phone_e164, '+15555550184')
  assert.equal(normalizeRetailPhone('+63 917 123 4567'), null)
})

test('retail verifier is purchase-intent and destination bound', () => {
  const env = localEnv()
  const base = {
    verificationId: '4bf85b92-5e75-4f60-9b2a-7ca79e52530d',
    purchaseIntentId: INTENT_ID,
    destinationFingerprint: 'a'.repeat(64),
    code: '123456',
    env,
  }
  const verifier = retailSmsVerifierHmac(base)
  assert.match(verifier, /^[0-9a-f]{64}$/)
  assert.notEqual(verifier, retailSmsVerifierHmac({ ...base, code: '123457' }))
  assert.notEqual(verifier, retailSmsVerifierHmac({ ...base, destinationFingerprint: 'b'.repeat(64) }))
})

test('retail SMS delivery commits a private challenge before one adapter call and persists no raw code or phone', async () => {
  const db = makeDb()
  const env = localEnv()
  const adapter = createFakeSmsProvider({ environment: 'local', mode: 'accepted' })
  const result = await deliverRetailSignupSmsOtp({
    db,
    intent: intent(),
    consentCopyVersion: RETAIL_SMS_CONSENT_COPY_VERSION,
    env,
    adapter,
    checkSuppressed: async () => false,
  })

  assert.equal(result.outcome, 'accepted')
  assert.equal(result.provider, 'fake')
  assert.equal(result.status, 'queued')
  assert.equal(result.challengeCreated, true)
  assert.equal(adapter.getCallCount(), 1)
  assert.match(db.state.issued.p_verifier_hmac_hex, /^[0-9a-f]{64}$/)
  assert.match(db.state.issued.p_destination_fingerprint, /^[0-9a-f]{64}$/)
  const stored = JSON.stringify(db.state.issued)
  assert.equal(stored.includes('5555550184'), false)
  assert.equal(stored.includes('+15555550184'), false)
  assert.equal(['code', 'p_code', 'otp_code', 'raw_code'].some((key) => Object.prototype.hasOwnProperty.call(db.state.issued, key)), false)
  assert.deepEqual(db.state.metadata.map((entry) => entry.p_event), ['send_requested', 'provider_accepted'])
})

test('retail SMS verification consumes only the matching HMAC and returns safe status metadata', async () => {
  const db = makeDb()
  const env = localEnv()
  const originalRandomInt = require('node:crypto').randomInt
  require('node:crypto').randomInt = () => 123456
  try {
    await deliverRetailSignupSmsOtp({
      db,
      intent: intent(),
      consentCopyVersion: RETAIL_SMS_CONSENT_COPY_VERSION,
      env,
      adapter: createFakeSmsProvider({ environment: 'local', mode: 'accepted' }),
      checkSuppressed: async () => false,
    })
  } finally {
    require('node:crypto').randomInt = originalRandomInt
  }

  const before = await loadRetailSmsVerificationState(db, intent(), env)
  assert.equal(before.codeActive, true)
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'code'), false)
  assert.equal((await consumeRetailSignupSmsOtp({ db, intent: intent(), code: '000000', env })).status, 'invalid')
  assert.equal(db.state.consumed, false)
  assert.equal((await consumeRetailSignupSmsOtp({ db, intent: intent(), code: '123456', env })).status, 'verified')
})

test('retail SMS migration keeps challenges private, enforces consent, cross-channel supersession, spend controls, and server-only RPC grants', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8')
  assert.match(migration, /create table if not exists private_auth\.retail_signup_sms_verifications/)
  assert.match(migration, /consent_copy_version text not null check \(consent_copy_version = 'sms-consent-v2'\)/)
  assert.match(migration, /update public\.retail_signup_email_verifications[\s\S]*channel_changed_to_sms/)
  assert.match(migration, /verified_by_email/)
  assert.match(migration, /private_auth\.sms_spend_reservations[\s\S]*private_auth\.retail_sms_spend_reservations/)
  assert.match(migration, /create or replace function private_auth\.reserve_sms_spend\([\s\S]*private_auth\.sms_spend_reservations[\s\S]*private_auth\.retail_sms_spend_reservations/)
  assert.match(migration, /revoke all on table private_auth\.retail_signup_sms_verifications from public, anon, authenticated, service_role/)
  assert.match(migration, /grant execute on function public\.service_issue_retail_signup_sms_verification\([\s\S]*\) to service_role/)
  assert.match(migration, /revoke all on function private_auth\.consume_retail_signup_sms_verification\(uuid,boolean\) from public, anon, authenticated, service_role/)
  assert.match(migration, /service_consume_retail_signup_sms_verification\(uuid,boolean\)/)
  assert.doesNotMatch(migration, /service_consume_retail_signup_sms_verification\(uuid,text,text\)/)
  assert.doesNotMatch(migration, /\b(phone_e164|to_e164|otp_code|raw_code)\s+text\b/i)
})

test('retail SMS resend migration enforces the 120-second delay without changing private function signatures', () => {
  const migration = fs.readFileSync(RESEND_COOLDOWN_MIGRATION_PATH, 'utf8')
  assert.match(migration, /private_auth\.issue_retail_signup_sms_verification\([\s\S]*interval '120 seconds'/)
  assert.match(migration, /private_auth\.get_retail_signup_sms_verification\([\s\S]*interval '120 seconds'/)
  assert.match(migration, /return query select 'issued'::text, p_verification_id, v_expires_at, 120/)
  assert.doesNotMatch(migration, /interval '60 seconds'/)
  assert.doesNotMatch(migration, /\b(phone_e164|to_e164|otp_code|raw_code)\s+text\b/i)
})

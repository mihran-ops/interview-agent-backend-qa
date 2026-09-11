'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const fs = require('fs')
const http = require('node:http')
const path = require('node:path')
const projectRoot = path.resolve(__dirname, '..')
const { test } = require('node:test')

const routePath = path.join(__dirname, '..', 'src', 'routes', 'public', 'alphascreen', 'index.js')
const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js')
const rateLimitPath = path.join(__dirname, '..', 'src', 'lib', 'rateLimit.js')
const mailerPath = path.join(__dirname, '..', 'utils', 'mailer.js')
const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260714212318_retail_signup_email_verification.sql')
const resendTimingMigrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260715120000_retail_signup_email_verification_resend_timing.sql')

const INTENT_ID = '11111111-1111-4111-8111-111111111111'

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

class FakeQuery {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.orderBy = null
    this.limitCount = null
    this.updatePayload = null
  }

  select() { return this }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value })
    return this
  }

  is(column, value) {
    this.filters.push({ type: 'is', column, value })
    return this
  }

  order(column, options = {}) {
    this.orderBy = { column, ascending: options.ascending === true }
    return this
  }

  limit(value) {
    this.limitCount = Number(value)
    return this
  }

  update(payload) {
    this.updatePayload = payload
    return this
  }

  rows() {
    if (this.table === 'public_purchase_intents') return this.db.purchaseIntents
    if (this.table === 'retail_signup_email_verifications') return this.db.verifications
    return []
  }

  matchingRows() {
    let rows = this.rows().filter((row) => this.filters.every((filter) => {
      if (filter.type === 'is') return row?.[filter.column] === filter.value
      return String(row?.[filter.column] || '') === String(filter.value || '')
    }))
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      rows = rows.slice().sort((left, right) => {
        const leftValue = String(left?.[column] || '')
        const rightValue = String(right?.[column] || '')
        return ascending ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue)
      })
    }
    if (Number.isFinite(this.limitCount)) rows = rows.slice(0, this.limitCount)
    return rows
  }

  async maybeSingle() {
    return { data: this.matchingRows()[0] || null, error: null }
  }

  async execute() {
    const rows = this.matchingRows()
    if (this.updatePayload) {
      rows.forEach((row) => Object.assign(row, this.updatePayload))
      return { data: rows, error: null }
    }
    return { data: rows, error: null }
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject)
  }
}

function intent(overrides = {}) {
  return {
    id: INTENT_ID,
    status: 'pending',
    selected_plan_key: 'basic',
    selected_billing_cadence: 'monthly',
    buyer_email: 'Alex@AcmeDental.example',
    buyer_phone: '+1 (555) 555-0184',
    email_verified_at: null,
    email_verified_address: null,
    email_verification_method: null,
    email_verification_version: null,
    phone_verified_at: null,
    phone_verified_destination_fingerprint: null,
    phone_verification_method: null,
    phone_verification_version: null,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides
  }
}

function makeDb(options = {}) {
  const db = {
    purchaseIntents: options.purchaseIntents || [intent()],
    verifications: options.verifications || [],
    smsVerification: null,
    rpcCalls: [],
    from(table) {
      return new FakeQuery(db, table)
    },
    async rpc(name, args) {
      db.rpcCalls.push({ name, args })
      if (name === 'issue_retail_signup_email_verification') {
        const status = options.issueStatus || 'issued'
        if (status !== 'issued') {
          return {
            data: [{
              status,
              resend_after_seconds: options.retryAfterSeconds || (status === 'resend_cooldown' ? 47 : 900)
            }],
            error: null
          }
        }
        const verification = {
          id: `verification-${db.verifications.length + 1}`,
          purchase_intent_id: args.p_purchase_intent_id,
          buyer_email: args.p_buyer_email,
          code_hash: args.p_code_hash,
          code_salt: args.p_code_salt,
          sent_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          used_at: null,
          invalidated_at: null
        }
        db.verifications.unshift(verification)
        return {
          data: [{
            status: 'issued',
            verification_id: verification.id,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            resend_after_seconds: 60
          }],
          error: null
        }
      }
      if (name === 'consume_retail_signup_email_verification') {
        const status = options.consumeStatus || 'verified'
        if (status === 'verified') {
          const currentIntent = db.purchaseIntents.find((row) => row.id === args.p_purchase_intent_id)
          currentIntent.email_verified_at = new Date().toISOString()
          currentIntent.email_verified_address = args.p_buyer_email
          currentIntent.email_verification_method = 'retail_signup_email_otp_v1'
          currentIntent.email_verification_version = 1
        }
        return { data: [{ status }], error: null }
      }
      if (name === 'service_invalidate_retail_signup_sms_verifications') {
        if (db.smsVerification && !db.smsVerification.consumed) db.smsVerification.invalidated = true
        return { data: 0, error: null }
      }
      if (name === 'service_get_retail_signup_sms_verification') {
        if (!db.smsVerification) return { data: [], error: null }
        return {
          data: [{
            verification_id: db.smsVerification.verificationId,
            verifier_hmac_hex: db.smsVerification.verifierHmacHex,
            verified: db.smsVerification.consumed === true,
            status: db.smsVerification.consumed ? 'verified' : db.smsVerification.invalidated ? 'unverified' : 'code_sent',
            expires_at: db.smsVerification.expiresAt,
            sent_at: db.smsVerification.sentAt,
            resend_after_seconds: 60
          }],
          error: null
        }
      }
      if (name === 'service_issue_retail_signup_sms_verification') {
        db.smsVerification = {
          verificationId: args.p_verification_id,
          verifierHmacHex: args.p_verifier_hmac_hex,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          sentAt: new Date().toISOString(),
          invalidated: false,
          consumed: false
        }
        return {
          data: [{
            status: 'issued',
            verification_id: db.smsVerification.verificationId,
            expires_at: db.smsVerification.expiresAt,
            resend_after_seconds: 60
          }],
          error: null
        }
      }
      if (name === 'service_record_retail_signup_sms_delivery_metadata') return { data: true, error: null }
      if (name === 'service_is_sms_destination_suppressed') return { data: false, error: null }
      if (name === 'service_consume_retail_signup_sms_verification') {
        const verified = args.p_verification_id === db.smsVerification?.verificationId && args.p_verifier_matches === true
        if (verified) {
          db.smsVerification.consumed = true
          const currentIntent = db.purchaseIntents.find((row) => row.id === INTENT_ID)
          currentIntent.phone_verified_at = new Date().toISOString()
          currentIntent.phone_verification_method = 'retail_signup_sms_otp_v1'
        }
        return { data: [{ status: verified ? 'verified' : 'invalid' }], error: null }
      }
      throw new Error(`Unexpected RPC ${name}`)
    }
  }
  return db
}

function buildApp(db, options = {}) {
  // The router is assembled from several files that each cache the modules stubbed
  // below, so every first-party module reloads on each build.
  for (const cached of Object.keys(require.cache)) {
    if (cached.startsWith(projectRoot) && !cached.includes('node_modules')) {
      delete require.cache[cached]
    }
  }
  const emails = []
  const rateLimitCalls = []
  delete require.cache[routePath]
  delete require.cache[supabaseClientPath]
  delete require.cache[rateLimitPath]
  delete require.cache[mailerPath]
  injectModule(supabaseClientPath, { supabaseAdmin: db })
  injectModule(rateLimitPath, {
    getRequestSubjectKey: () => '198.51.100.10',
    hashRateLimitSubject: (...parts) => `hash:${parts.join(':')}`,
    checkAndIncrementRateLimit: async (input) => {
      rateLimitCalls.push(input)
      if (typeof options.checkRateLimit === 'function') return options.checkRateLimit(input)
      return { allowed: true, retryAfterSeconds: 0 }
    }
  })
  injectModule(mailerPath, {
    async sendRetailSignupEmailVerificationCode(to, code, details) {
      if (options.mailerError) throw new Error('mail_send_failed')
      emails.push({ to, code, details })
      return { statusCode: 202 }
    }
  })
  const router = require(routePath)
  const app = express()
  app.use(express.json())
  app.use('/api/alphascreen', router)
  return { app, emails, rateLimitCalls }
}

async function request(app, pathname, options = {}) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function withRetailSmsEnv(callback) {
  const values = {
    NODE_ENV: 'test',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_ENABLED: 'true',
    SMS_RETAIL_UI_ENABLED: 'true',
    SMS_CONSENT_COPY_VERSION: 'sms-consent-v2',
    SMS_FAKE_MODE: 'accepted',
    OTP_HMAC_SECRET_VERSION: '1',
    OTP_HMAC_SECRET_V1: 'retail-route-test-secret-that-is-at-least-thirty-two-bytes'
  }
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  try {
    return await callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('retail email verification sends a six-digit code while persisting only a hash bound to the normalized intent email', async () => {
  const db = makeDb()
  const { app, emails } = buildApp(db)
  const response = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/send`, { method: 'POST' })

  assert.equal(response.status, 202)
  assert.equal(response.body.email_verification.status, 'code_sent')
  assert.equal(emails.length, 1)
  assert.match(emails[0].code, /^\d{6}$/)
  assert.equal(emails[0].to, 'alex@acmedental.example')
  assert.equal(db.verifications.length, 1)
  assert.equal(db.verifications[0].buyer_email, 'alex@acmedental.example')
  assert.notEqual(db.verifications[0].code_hash, emails[0].code)
  assert.equal(db.verifications[0].code_hash.length, 64)
  assert.equal(db.verifications[0].code_salt.length, 64)
  assert.equal(
    db.rpcCalls.find((call) => call.name === 'issue_retail_signup_email_verification').args.p_code_hash,
    db.verifications[0].code_hash
  )
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(emails[0].code))
})

test('retail email verification reports resend cooldown and hourly limits without sending a code', async () => {
  for (const [issueStatus, expectedCode] of [
    ['resend_cooldown', 'RETAIL_EMAIL_VERIFICATION_COOLDOWN'],
    ['hourly_limit', 'RETAIL_EMAIL_VERIFICATION_SEND_LIMIT']
  ]) {
    const db = makeDb({ issueStatus })
    const { app, emails } = buildApp(db)
    const response = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/send`, { method: 'POST' })
    assert.equal(response.status, 429)
    assert.equal(response.body.code, expectedCode)
    assert.ok(Number(response.body.retry_after_seconds) > 0)
    assert.ok(Number(response.headers.get('retry-after')) > 0)
    assert.equal(emails.length, 0)
  }
})

test('retail email verification maps invalid, expired, and attempt-limited codes to safe public responses', async () => {
  for (const [consumeStatus, expectedStatus, expectedCode] of [
    ['invalid', 400, 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE'],
    ['expired', 400, 'RETAIL_EMAIL_VERIFICATION_EXPIRED'],
    ['attempt_limit', 429, 'RETAIL_EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED']
  ]) {
    const db = makeDb({
      consumeStatus,
      verifications: [{
        id: 'verification-1',
        purchase_intent_id: INTENT_ID,
        buyer_email: 'alex@acmedental.example',
        code_salt: 'a'.repeat(64),
        created_at: new Date().toISOString()
      }]
    })
    const { app } = buildApp(db)
    const response = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/verify`, {
      method: 'POST',
      body: { code: '123456' }
    })
    assert.equal(response.status, expectedStatus)
    assert.equal(response.body.code, expectedCode)
  }
})

test('successful retail email verification updates the matching purchase intent and status is server authoritative', async () => {
  const db = makeDb({
    verifications: [{
      id: 'verification-1',
      purchase_intent_id: INTENT_ID,
      buyer_email: 'alex@acmedental.example',
      code_salt: 'b'.repeat(64),
      created_at: new Date().toISOString()
    }]
  })
  const { app } = buildApp(db)
  const verifyResponse = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/verify`, {
    method: 'POST',
    body: { code: '123456' }
  })
  const statusResponse = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/status`)

  assert.equal(verifyResponse.status, 200)
  assert.equal(verifyResponse.body.email_verification.verified, true)
  assert.equal(db.purchaseIntents[0].email_verified_address, 'alex@acmedental.example')
  assert.equal(statusResponse.status, 200)
  assert.equal(statusResponse.body.email_verification.verified, true)
})

test('status returns only safe active-code and remaining resend timing metadata', async () => {
  const db = makeDb({
    verifications: [{
      id: 'verification-1',
      purchase_intent_id: INTENT_ID,
      buyer_email: 'alex@acmedental.example',
      code_salt: 'c'.repeat(64),
      sent_at: new Date(Date.now() - 12 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
      used_at: null,
      invalidated_at: null,
      created_at: new Date().toISOString()
    }]
  })
  const { app } = buildApp(db)
  const response = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/status`)

  assert.equal(response.status, 200)
  assert.equal(response.body.email_verification.code_active, true)
  assert.ok(response.body.email_verification.resend_cooldown_seconds >= 45)
  assert.ok(response.body.email_verification.resend_cooldown_seconds <= 60)
  assert.doesNotMatch(JSON.stringify(response.body), /code_salt|verification-1/)
})

test('email verification rate-limit keys isolate sends by intent and verification attempts by issuance', async () => {
  const otherIntentId = '22222222-2222-4222-8222-222222222222'
  const db = makeDb({
    consumeStatus: 'invalid',
    purchaseIntents: [
      intent(),
      intent({ id: otherIntentId, buyer_email: 'buyer@anotherdental.example' })
    ],
    verifications: [
      {
        id: 'verification-1',
        purchase_intent_id: INTENT_ID,
        buyer_email: 'alex@acmedental.example',
        code_salt: 'd'.repeat(64),
        sent_at: new Date(Date.now() - 61 * 1000).toISOString(),
        expires_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString()
      },
      {
        id: 'verification-2',
        purchase_intent_id: otherIntentId,
        buyer_email: 'buyer@anotherdental.example',
        code_salt: 'e'.repeat(64),
        sent_at: new Date(Date.now() - 61 * 1000).toISOString(),
        expires_at: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString()
      }
    ]
  })
  const { app, rateLimitCalls } = buildApp(db)
  const verify = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/verify`, {
    method: 'POST',
    body: { code: '123456' }
  })
  const first = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/send`, { method: 'POST' })
  const second = await request(app, `/api/alphascreen/purchase-intents/${otherIntentId}/email-verification/send`, { method: 'POST' })

  assert.equal(first.status, 202)
  assert.equal(second.status, 202)
  assert.equal(verify.status, 400)
  const sendCalls = rateLimitCalls.filter((call) => call.routeName === 'retail_email_verification_send')
  assert.equal(sendCalls.length, 2)
  assert.notEqual(sendCalls[0].subjectKey, sendCalls[1].subjectKey)
  const verifyCall = rateLimitCalls.find((call) => call.routeName === 'retail_email_verification_verify')
  assert.match(verifyCall.subjectKey, /verification-1/)
})

test('email verification route-level abuse protection returns retry metadata without sharing status quota', async () => {
  const db = makeDb()
  const { app } = buildApp(db, {
    checkRateLimit(input) {
      if (input.routeName === 'retail_email_verification_send') {
        return { allowed: false, retryAfterSeconds: 23 }
      }
      return { allowed: true, retryAfterSeconds: 0 }
    }
  })
  const status = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/status`)
  const send = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/send`, { method: 'POST' })

  assert.equal(status.status, 200)
  assert.equal(send.status, 429)
  assert.equal(send.body.code, 'RETAIL_PUBLIC_RATE_LIMITED')
  assert.equal(send.body.retry_after_seconds, 23)
  assert.equal(send.headers.get('retry-after'), '23')
})

test('email delivery failure invalidates the issued verification and never marks the purchase intent verified', async () => {
  const db = makeDb()
  const { app } = buildApp(db, { mailerError: true })
  const response = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/email-verification/send`, { method: 'POST' })

  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'RETAIL_EMAIL_VERIFICATION_SEND_FAILED')
  assert.equal(db.purchaseIntents[0].email_verified_at, null)
  assert.equal(db.verifications[0].invalidation_reason, 'delivery_failed')
})

test('retail SMS routes require consent, keep codes private, and verify through a timing-safe boolean boundary', async () => {
  await withRetailSmsEnv(async () => {
    const db = makeDb()
    const { app } = buildApp(db)
    const missingConsent = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/sms-verification/send`, {
      method: 'POST',
      body: {}
    })
    assert.equal(missingConsent.status, 400)
    assert.equal(missingConsent.body.code, 'RETAIL_SMS_CONSENT_REQUIRED')

    const crypto = require('node:crypto')
    const originalRandomInt = crypto.randomInt
    crypto.randomInt = () => 123456
    let sent
    try {
      sent = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/sms-verification/send`, {
        method: 'POST',
        body: { consent_copy_version: 'sms-consent-v2' }
      })
    } finally {
      crypto.randomInt = originalRandomInt
    }

    assert.equal(sent.status, 202)
    assert.equal(sent.body.sms_verification.status, 'code_sent')
    assert.doesNotMatch(JSON.stringify(sent.body), /verifier|destination_fingerprint|123456/i)
    const issueCall = db.rpcCalls.find((call) => call.name === 'service_issue_retail_signup_sms_verification')
    assert.ok(issueCall)
    assert.equal(issueCall.args.p_consent_copy_version, 'sms-consent-v2')
    assert.match(issueCall.args.p_verifier_hmac_hex, /^[0-9a-f]{64}$/)
    assert.equal(Object.values(issueCall.args).includes('123456'), false)
    assert.equal(Object.values(issueCall.args).some((value) => String(value).includes('5555550184')), false)

    const status = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/sms-verification/status`)
    assert.equal(status.status, 200)
    assert.equal(status.body.sms_verification.code_active, true)
    assert.doesNotMatch(JSON.stringify(status.body), /verifier_hmac|destination_fingerprint/i)

    const wrong = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/sms-verification/verify`, {
      method: 'POST',
      body: { code: '000000' }
    })
    const correct = await request(app, `/api/alphascreen/purchase-intents/${INTENT_ID}/sms-verification/verify`, {
      method: 'POST',
      body: { code: '123456' }
    })
    assert.equal(wrong.status, 400)
    assert.equal(wrong.body.code, 'RETAIL_SMS_VERIFICATION_INVALID_CODE')
    assert.equal(correct.status, 200)
    assert.equal(correct.body.sms_verification.verified, true)
    assert.deepEqual(
      db.rpcCalls.filter((call) => call.name === 'service_consume_retail_signup_sms_verification').map((call) => call.args.p_verifier_matches),
      [false, true]
    )
  })
})

test('retail verification migration isolates OTP records and enforces expiry, attempts, RLS, and transactional consume semantics', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8')
  assert.match(migration, /create table if not exists public\.retail_signup_email_verifications/)
  assert.doesNotMatch(migration, /otp_tokens/)
  assert.match(migration, /code_hash text not null/)
  assert.match(migration, /code_salt text not null/)
  assert.match(migration, /attempt_count between 0 and 5/)
  assert.match(migration, /interval '10 minutes'/)
  assert.match(migration, /interval '60 seconds'/)
  assert.match(migration, /interval '1 hour'/)
  assert.match(migration, /for update/)
  assert.match(migration, /revoke all on table public\.retail_signup_email_verifications from anon/)
})

test('resend timing migration returns the true remaining hourly wait without exposing verification values', () => {
  const migration = fs.readFileSync(resendTimingMigrationPath, 'utf8')
  assert.match(migration, /create or replace function public\.issue_retail_signup_email_verification/)
  assert.match(migration, /min\(sent_at\)/)
  assert.match(migration, /v_oldest_hourly_sent_at \+ interval '1 hour'/)
  assert.match(migration, /greatest\(1, ceil\(extract\(epoch from/)
  assert.doesNotMatch(migration, /code_hash.*select/i)
  assert.doesNotMatch(migration, /delete from public\.retail_signup_email_verifications/i)
})

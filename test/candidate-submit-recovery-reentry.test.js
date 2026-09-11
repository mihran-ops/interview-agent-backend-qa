'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const { destinationFingerprint } = require('../src/services/otpChallenge');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.SENDGRID_API_KEY = 'test-sendgrid-key';
process.env.SENDGRID_FROM = 'qa@example.test';
process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
process.env.INTERVIEW_RECOVERY_CORE_EMAIL_ENABLED = 'false';
process.env.OTP_HMAC_SECRET_VERSION = '1';
process.env.OTP_HMAC_SECRET_V1 = '11'.repeat(32);

const ID = {
  candidate: '76000000-0000-4000-8000-000000000001',
  client: '76000000-0000-4000-8000-000000000002',
  role: '76000000-0000-4000-8000-000000000003',
  prior: '76000000-0000-4000-8000-000000000004',
  authorization: '76000000-0000-4000-8000-000000000005',
  adjudication: '76000000-0000-4000-8000-000000000006',
  submission: '76000000-0000-4000-8000-000000000007',
};

class FakeQuery {
  constructor(context, table) {
    this.context = context;
    this.table = table;
    this.filters = {};
    this.operation = 'select';
    this.value = null;
  }

  select() { return this; }
  eq(field, value) { this.filters[field] = value; return this; }
  is(field, value) { this.filters[field] = value; return this; }
  order() { return this; }
  limit() { return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  insert(value) { this.operation = 'insert'; this.value = value; return this; }

  execute(single = false) {
    const { scenario, tracker } = this.context;
    if (this.operation === 'update') {
      tracker.updates.push({ table: this.table, value: this.value, filters: this.filters });
      return { data: null, error: null };
    }
    if (this.operation === 'insert') {
      tracker.inserts.push({ table: this.table, value: this.value });
      return { data: this.value, error: null };
    }
    if (this.table === 'roles') return { data: scenario.role, error: null };
    if (this.table === 'candidates') return { data: scenario.candidate, error: null };
    if (this.table === 'interviews') {
      const rows = scenario.interviews;
      return { data: single ? (rows[0] || null) : rows, error: null };
    }
    if (this.table === 'interview_reset_events') {
      const rows = scenario.authorizations;
      return { data: single ? (rows[0] || null) : rows, error: null };
    }
    return { data: single ? null : [], error: null };
  }

  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
}

function authorization(overrides = {}) {
  return {
    id: ID.authorization,
    adjudication_id: ID.adjudication,
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    previous_interview_id: ID.prior,
    replacement_interview_id: null,
    authorization_status: 'authorized',
    consumed_at: null,
    expires_at: null,
    reset_mode: 'reset_only',
    required_coverage_attested: true,
    client_approval_status: 'acknowledged',
    start_status: 'not_started',
    start_attempt_count: 0,
    email_status: 'not_requested',
    ...overrides,
  };
}

function scenario(overrides = {}) {
  const prior = {
    id: ID.prior,
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    status: 'Incomplete',
    attempt_number: 1,
    is_active: false,
    replacement_authorization_id: null,
    updated_at: '2026-07-27T20:08:10.547884Z',
  };
  return {
    candidate: {
      id: ID.candidate,
      name: 'Synthetic Recovery Candidate',
      email: 'recovery@example.test',
      phone: '3039008821',
      phone_e164: '+13039008821',
      phone_country_code: 'US',
      verified: true,
      status: 'Verified',
      interview_status: null,
      resume_url: 'resumes/synthetic.pdf',
      client_id: ID.client,
      role_id: ID.role,
    },
    role: {
      id: ID.role,
      title: 'Synthetic Role',
      client_id: ID.client,
      status: 'active',
      description: 'Synthetic role description',
    },
    interviews: [prior],
    authorizations: [authorization()],
    eligibility: {
      eligible: false,
      blockers: ['replacement_already_authorized'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: {
        authorization_id: ID.authorization,
        status: 'authorized',
        start_status: 'not_started',
        replacement_interview_id: null,
        reset_mode: 'reset_only',
        email_status: 'not_requested',
      },
    },
    ...overrides,
  };
}

function installModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function buildContext(currentScenario) {
  const tracker = {
    inserts: [],
    updates: [],
    ledger: [],
    reservations: new Map(),
    failures: [],
    emails: 0,
    providerCalls: 0,
    rpcs: [],
    challenges: [],
  };
  const context = {
    scenario: currentScenario,
    tracker,
    from(table) { return new FakeQuery(context, table); },
    async rpc(name, args) {
      tracker.rpcs.push({ name, args });
      if (name === 'get_interview_recovery_core_eligibility') {
        if (currentScenario.eligibilityError) {
          return { data: null, error: { message: 'synthetic eligibility lookup failure' } };
        }
        return { data: currentScenario.eligibility, error: null };
      }
      if (name === 'service_issue_otp_challenge') {
        tracker.challenges.push(args);
        return { data: [{ challenge_id: args.p_challenge_id, expires_at: '2026-08-10T18:00:00Z' }], error: null };
      }
      if (name === 'service_is_sms_destination_suppressed') {
        return { data: currentScenario.smsSuppressed === true, error: null };
      }
      if (name === 'service_issue_sms_otp_challenge') {
        tracker.challenges.push(args);
        return { data: [{ challenge_id: args.p_challenge_id, expires_at: '2027-08-10T18:00:00Z' }], error: null };
      }
      if (name === 'service_record_otp_sms_delivery_metadata') {
        return {
          data: [{
            challenge_id: args.p_challenge_id,
            provider: args.p_provider,
            provider_message_id: args.p_provider_message_id,
            delivery_status: args.p_delivery_status,
            failure_category: args.p_failure_category,
          }],
          error: null,
        };
      }
      if (name === 'service_mark_otp_challenge_delivery') return { data: true, error: null };
      return { data: null, error: { message: `unexpected_rpc:${name}` } };
    },
    storage: {
      from() {
        return {
          upload: async () => ({ data: {}, error: null }),
          remove: async () => ({ data: {}, error: null }),
        };
      },
    },
  };
  return context;
}

function loadRouter(context) {
  const idempotency = {
    CandidateSubmissionKeyError: class CandidateSubmissionKeyError extends Error {},
    async reserveCandidateSubmission(_db, { submissionKey }) {
      const existing = context.tracker.reservations.get(submissionKey);
      if (existing?.status === 'completed') return { state: 'replay', row: existing };
      if (existing?.status === 'failed') return { state: 'acquired', row: { id: submissionKey } };
      return { state: 'acquired', row: { id: submissionKey } };
    },
    async completeCandidateSubmission(_db, reservation, result) {
      const row = {
        status: 'completed',
        response_status: result.status,
        response_body: result.body,
        candidate_id: result.candidateId,
      };
      context.tracker.reservations.set(reservation.row.id, row);
      context.tracker.ledger.push(row);
    },
    async failCandidateSubmission(_db, reservation, result) {
      const row = {
        id: reservation.row.id,
        status: 'failed',
        candidate_id: result.candidateId,
        last_error_code: result.code,
      };
      context.tracker.reservations.set(reservation.row.id, row);
      context.tracker.failures.push(row);
    },
  };
  installModule('../src/clients/supabase', { supabase: context, supabaseAdmin: context });
  installModule('../src/services/rateLimit', {
    getRequestSubjectKey: () => 'synthetic-subject',
    checkAndIncrementRateLimit: async () => ({ allowed: true }),
  });
  installModule('../src/services/roleInterviewAvailability', {
    getRoleInterviewAvailability: async () => ({ remaining_interviews: 5 }),
    syncRoleInterviewLimitNotification: async () => {},
  });
  installModule('../src/services/candidateSubmissionIdempotency', idempotency);
  installModule('../src/services/analyzeResume', async () => ({ synthetic: true }));

  const sg = require('@sendgrid/mail');
  sg.setApiKey = () => {};
  sg.send = async () => {
    context.tracker.emails += 1;
    return [{ statusCode: 202 }];
  };

  const routePath = require.resolve('../src/routes/public/candidateSubmit');
  delete require.cache[routePath];
  return require(routePath);
}

async function withServer(router, callback) {
  const app = express();
  app.use((req, _res, next) => {
    req.request_id = 'synthetic-request-id';
    next();
  });
  app.use('/api/candidate/submit', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function submissionForm(submissionKey = ID.submission, channel = 'email') {
  const form = new FormData();
  form.append('first_name', 'Synthetic Recovery');
  form.append('last_name', 'Candidate');
  form.append('email', 'recovery@example.test');
  form.append('phone_country', 'US');
  form.append('phone', '3039008821');
  form.append('role_id', ID.role);
  form.append('submission_key', submissionKey);
  form.append('otp_channel', channel);
  if (channel === 'sms') form.append('consent_copy_version', 'sms-consent-v2');
  const pdfPath = process.env.RECOVERY_REENTRY_PDF_PATH
    || path.join(__dirname, 'fixtures', 'jd-parser-repeated-letters.pdf');
  const pdf = fs.readFileSync(pdfPath);
  form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'synthetic-resume.pdf');
  return form;
}

async function submit(context, submissionKey = ID.submission, channel = 'email') {
  let result;
  await withServer(loadRouter(context), async (base) => {
    const response = await fetch(`${base}/api/candidate/submit`, {
      method: 'POST',
      body: submissionForm(submissionKey, channel),
    });
    result = { status: response.status, body: await response.json() };
  });
  await new Promise((resolve) => setImmediate(resolve));
  return result;
}

test('authorized reset-only candidate re-entry reaches the normal OTP boundary without creating attempt two', async () => {
  const context = buildContext(scenario());
  const priorBefore = structuredClone(context.scenario.interviews[0]);
  const authorizationBefore = structuredClone(context.scenario.authorizations[0]);
  const response = await submit(context);
  assert.equal(response.status, 200);
  assert.equal(response.body.candidate_id, ID.candidate);
  assert.equal(context.tracker.challenges.length, 1);
  assert.equal(context.tracker.ledger.length, 1);
  assert.equal(context.tracker.emails, 1);
  assert.equal(context.tracker.inserts.filter((entry) => entry.table === 'reports').length, 0);
  assert.equal(context.scenario.interviews.length, 1);
  assert.deepEqual(context.scenario.interviews[0], priorBefore);
  assert.deepEqual(context.scenario.authorizations[0], authorizationBefore);
  assert.equal(context.tracker.providerCalls, 0);
});

test('authorized QA SMS selection uses the fake provider, records consent, and sends no email', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    SMS_CANDIDATE_UI_ENABLED: process.env.SMS_CANDIDATE_UI_ENABLED,
    SMS_ENABLED: process.env.SMS_ENABLED,
    SMS_ENVIRONMENT: process.env.SMS_ENVIRONMENT,
    SMS_PROVIDER: process.env.SMS_PROVIDER,
    SMS_CONSENT_COPY_VERSION: process.env.SMS_CONSENT_COPY_VERSION,
  };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SMS_CANDIDATE_UI_ENABLED: 'true',
    SMS_ENABLED: 'true',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_CONSENT_COPY_VERSION: 'sms-consent-v2',
  });
  try {
    const context = buildContext(scenario());
    const response = await submit(context, '76000000-0000-4000-8000-000000000077', 'sms');
    assert.equal(response.status, 200);
    assert.equal(response.body.delivery_channel, 'sms');
    assert.equal(response.body.delivery_outcome, 'accepted');
    assert.equal(response.body.email_fallback_available, false);
    assert.match(response.body.challenge_id, /^[0-9a-f-]{36}$/);
    assert.equal(context.tracker.emails, 0);
    const issued = context.tracker.rpcs.find((call) => call.name === 'service_issue_sms_otp_challenge');
    assert.ok(issued);
    assert.equal(issued.args.p_consent_copy_version, 'sms-consent-v2');
    assert.match(issued.args.p_sms_selection_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(response.body).includes('+13039008821'), false);
    assert.equal(JSON.stringify(response.body).includes('fake_'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('pre-challenge SMS suppression leaves idempotency retryable and the same key can issue email', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    SMS_CANDIDATE_UI_ENABLED: process.env.SMS_CANDIDATE_UI_ENABLED,
    SMS_ENABLED: process.env.SMS_ENABLED,
    SMS_ENVIRONMENT: process.env.SMS_ENVIRONMENT,
    SMS_PROVIDER: process.env.SMS_PROVIDER,
    SMS_CONSENT_COPY_VERSION: process.env.SMS_CONSENT_COPY_VERSION,
  };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SMS_CANDIDATE_UI_ENABLED: 'true',
    SMS_ENABLED: 'true',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_CONSENT_COPY_VERSION: 'sms-consent-v2',
  });
  try {
    const context = buildContext(scenario({ smsSuppressed: true }));
    const submissionKey = '76000000-0000-4000-8000-000000000088';
    const smsResponse = await submit(context, submissionKey, 'sms');
    assert.equal(smsResponse.status, 200);
    assert.equal(smsResponse.body.challenge_id, null);
    assert.equal(smsResponse.body.delivery_outcome, 'blocked_destination');
    assert.equal(smsResponse.body.email_fallback_available, true);
    assert.equal(context.tracker.reservations.get(submissionKey).status, 'failed');
    assert.equal(context.tracker.failures.length, 1);
    assert.equal(context.tracker.emails, 0);

    const emailResponse = await submit(context, submissionKey, 'email');
    assert.equal(emailResponse.status, 200);
    assert.match(emailResponse.body.challenge_id, /^[0-9a-f-]{36}$/);
    assert.equal(emailResponse.body.delivery_channel, 'email');
    assert.equal(context.tracker.reservations.get(submissionKey).status, 'completed');
    assert.equal(context.tracker.emails, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('existing candidate SMS reconciles stale canonical fields and binds the request-normalized E.164', async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    SMS_CANDIDATE_UI_ENABLED: process.env.SMS_CANDIDATE_UI_ENABLED,
    SMS_ENABLED: process.env.SMS_ENABLED,
    SMS_ENVIRONMENT: process.env.SMS_ENVIRONMENT,
    SMS_PROVIDER: process.env.SMS_PROVIDER,
    SMS_CONSENT_COPY_VERSION: process.env.SMS_CONSENT_COPY_VERSION,
  };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    SMS_CANDIDATE_UI_ENABLED: 'true',
    SMS_ENABLED: 'true',
    SMS_ENVIRONMENT: 'local',
    SMS_PROVIDER: 'fake',
    SMS_CONSENT_COPY_VERSION: 'sms-consent-v2',
  });
  try {
    const context = buildContext(scenario({
      candidate: {
        ...scenario().candidate,
        phone_e164: '+13035550199',
        phone_country_code: 'US',
      },
    }));
    const response = await submit(context, '76000000-0000-4000-8000-000000000099', 'sms');
    assert.equal(response.status, 200);
    assert.equal(response.body.delivery_outcome, 'accepted');
    assert.ok(context.tracker.updates.some((entry) => (
      entry.table === 'candidates'
      && entry.value.phone_e164 === '+13039008821'
      && entry.value.phone_country_code === 'US'
    )));
    const issued = context.tracker.rpcs.find((call) => call.name === 'service_issue_sms_otp_challenge');
    assert.ok(issued);
    assert.equal(
      issued.args.p_destination_fingerprint,
      destinationFingerprint('+13039008821', undefined, process.env, 'sms')
    );
    assert.notEqual(
      issued.args.p_destination_fingerprint,
      destinationFingerprint('+13035550199', undefined, process.env, 'sms')
    );
    assert.equal(JSON.stringify(response.body).includes('+13035550199'), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const [name, currentScenario] of [
  ['no authorization', scenario({
    authorizations: [],
    eligibility: {
      eligible: true,
      blockers: [],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: null,
    },
  })],
  ['wrong candidate authorization', scenario({
    authorizations: [authorization({ candidate_id: '76000000-0000-4000-8000-000000000099' })],
  })],
  ['wrong role authorization', scenario({
    authorizations: [authorization({ role_id: '76000000-0000-4000-8000-000000000099' })],
  })],
  ['wrong client authorization', scenario({
    authorizations: [authorization({ client_id: '76000000-0000-4000-8000-000000000099' })],
  })],
  ['wrong prior-interview authorization', scenario({
    authorizations: [authorization({ previous_interview_id: '76000000-0000-4000-8000-000000000099' })],
  })],
  ['consumed authorization', scenario({
    authorizations: [authorization({
      authorization_status: 'consumed',
      consumed_at: '2026-07-27T21:40:00Z',
    })],
    eligibility: {
      eligible: false,
      blockers: ['replacement_already_used'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: {
        authorization_id: ID.authorization,
        status: 'consumed',
        start_status: 'not_started',
        replacement_interview_id: null,
        reset_mode: 'reset_only',
        email_status: 'not_requested',
      },
    },
  })],
  ['revoked authorization', scenario({
    authorizations: [authorization({ authorization_status: 'revoked' })],
    eligibility: {
      eligible: false,
      blockers: ['replacement_already_authorized'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: {
        authorization_id: ID.authorization,
        status: 'revoked',
        start_status: 'not_started',
        replacement_interview_id: null,
        reset_mode: 'reset_only',
        email_status: 'not_requested',
      },
    },
  })],
  ['authorization with an existing replacement', scenario({
    authorizations: [authorization({
      replacement_interview_id: '76000000-0000-4000-8000-000000000098',
    })],
  })],
  ['authorization whose start already began', scenario({
    authorizations: [authorization({ start_status: 'starting', start_attempt_count: 1 })],
    eligibility: {
      eligible: false,
      blockers: ['replacement_already_authorized'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: {
        authorization_id: ID.authorization,
        status: 'authorized',
        start_status: 'starting',
        replacement_interview_id: null,
        reset_mode: 'reset_only',
        email_status: 'not_requested',
      },
    },
  })],
  ['authorization whose start completed', scenario({
    authorizations: [authorization({ start_status: 'started', start_attempt_count: 1 })],
    eligibility: {
      eligible: false,
      blockers: ['replacement_already_authorized'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Incomplete' },
      replacement: {
        authorization_id: ID.authorization,
        status: 'authorized',
        start_status: 'started',
        replacement_interview_id: null,
        reset_mode: 'reset_only',
        email_status: 'not_requested',
      },
    },
  })],
  ['ambiguous authorizations', scenario({
    authorizations: [
      authorization(),
      authorization({ id: '76000000-0000-4000-8000-000000000098' }),
    ],
  })],
]) {
  test(`${name} preserves the ordinary existing-interview conflict and creates no OTP`, async () => {
    process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
    const context = buildContext(currentScenario);
    const response = await submit(context);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'RETAKE_AUTHORIZATION_REQUIRED');
    assert.equal(context.tracker.challenges.length, 0);
    assert.equal(context.tracker.emails, 0);
    assert.equal(context.scenario.interviews.length, 1);
  });
}

test('an existing attempt two prevents another verification flow', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const currentScenario = scenario();
  currentScenario.interviews.push({
    id: '76000000-0000-4000-8000-000000000098',
    candidate_id: ID.candidate,
    client_id: ID.client,
    role_id: ID.role,
    status: 'Incomplete',
    attempt_number: 2,
    is_active: false,
    replacement_authorization_id: ID.authorization,
  });
  const context = buildContext(currentScenario);
  const response = await submit(context);
  assert.equal(response.status, 409);
  assert.equal(context.tracker.challenges.length, 0);
  assert.equal(context.scenario.interviews.length, 2);
});

test('Recovery Core disabled preserves the ordinary conflict without authorization lookup', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'false';
  const context = buildContext(scenario());
  const response = await submit(context);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'RETAKE_AUTHORIZATION_REQUIRED');
  assert.equal(context.tracker.rpcs.length, 0);
  assert.equal(context.tracker.challenges.length, 0);
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
});

test('an expired authorization fails closed', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const context = buildContext(scenario({
    authorizations: [authorization({ expires_at: '2020-01-01T00:00:00Z' })],
  }));
  const response = await submit(context);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'RETAKE_AUTHORIZATION_REQUIRED');
  assert.equal(context.tracker.challenges.length, 0);
});

test('an authorization lookup failure is retryable and creates no OTP', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const context = buildContext(scenario({ eligibilityError: true }));
  const response = await submit(context);
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'TEMPORARY_SERVICE_ERROR');
  assert.equal(context.tracker.challenges.length, 0);
  assert.equal(context.tracker.emails, 0);
});

test('a completed interview without a usable authorization remains blocked', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const currentScenario = scenario({
    authorizations: [],
    eligibility: {
      eligible: false,
      blockers: ['completed_interview_retake_blocked'],
      candidate: { id: ID.candidate },
      role: { id: ID.role },
      prior_interview: { id: ID.prior, attempt_number: 1, status: 'Completed' },
      replacement: null,
    },
  });
  currentScenario.interviews[0].status = 'Completed';
  const context = buildContext(currentScenario);
  const response = await submit(context);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'INTERVIEW_ALREADY_COMPLETED');
  assert.equal(context.tracker.challenges.length, 0);
});

test('replaying the same successful submission key does not duplicate OTP, email, candidate, or ledger work', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const context = buildContext(scenario());
  const first = await submit(context);
  const second = await submit(context);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(context.tracker.challenges.length, 1);
  assert.equal(context.tracker.inserts.filter((entry) => entry.table === 'candidates').length, 0);
  assert.equal(context.tracker.emails, 1);
  assert.equal(context.tracker.ledger.length, 1);
  assert.equal(context.scenario.authorizations[0].authorization_status, 'authorized');
});

test('ordinary first-time application still creates one candidate and one OTP', async () => {
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  const context = buildContext(scenario({
    candidate: null,
    interviews: [],
    authorizations: [],
    eligibility: null,
  }));
  const response = await submit(context);
  assert.equal(response.status, 200);
  const candidateInserts = context.tracker.inserts.filter((entry) => entry.table === 'candidates');
  assert.equal(candidateInserts.length, 1);
  assert.equal(candidateInserts[0].value.phone, '3039008821');
  assert.equal(candidateInserts[0].value.phone_e164, '+13039008821');
  assert.equal(candidateInserts[0].value.phone_country_code, 'US');
  assert.equal(context.tracker.challenges.length, 1);
  assert.equal(context.tracker.ledger.length, 1);
  assert.equal(context.tracker.emails, 1);
});

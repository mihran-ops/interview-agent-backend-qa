'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');

process.env.SUPABASE_URL ||= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.SUPABASE_ANON_KEY ||= 'test-anon-key';
process.env.OTP_HMAC_SECRET_VERSION ||= '1';
process.env.OTP_HMAC_SECRET_V1 ||= '22'.repeat(32);

const { createInterviewRecoveryRouter } = require('../src/routes/admin/interviewRecovery');
const {
  claimInterviewAttempt,
  isInterviewRecoveryCoreEnabled,
  isInterviewRecoveryCoreEmailEnabled,
} = require('../src/services/interviewAttemptService');

const ID = {
  candidate: '72000000-0000-4000-8000-000000000001',
  client: '72000000-0000-4000-8000-000000000002',
  role: '72000000-0000-4000-8000-000000000003',
  prior: '72000000-0000-4000-8000-000000000004',
  actor: '72000000-0000-4000-8000-000000000005',
  key: '72000000-0000-4000-8000-000000000006',
  authorization: '72000000-0000-4000-8000-000000000007',
  adjudication: '72000000-0000-4000-8000-000000000008',
  audit: '72000000-0000-4000-8000-000000000009',
};

class FakeQuery {
  constructor(result, tracker, table) {
    this.result = result;
    this.tracker = tracker;
    this.table = table;
  }
  select() { return this; }
  eq() { return this; }
  is() { return this; }
  update(value) { this.tracker.updates.push({ table: this.table, value }); return this; }
  insert(value) { this.tracker.inserts.push({ table: this.table, value }); return this; }
  single() { return Promise.resolve(this.result); }
  maybeSingle() { return Promise.resolve(this.result); }
  then(resolve, reject) { return Promise.resolve(this.result).then(resolve, reject); }
}

function createFakeDb({ wrongClient = false } = {}) {
  const tracker = { rpc: [], inserts: [], updates: [], authorizationCalls: 0, challenges: [] };
  const candidate = { id: ID.candidate, name: 'Synthetic Candidate', email: 'candidate@example.test', client_id: ID.client, role_id: ID.role };
  const role = { id: ID.role, title: 'Synthetic Role', slug_or_token: 'synthetic-role', client_id: ID.client };
  const eligibility = {
    eligible: !wrongClient,
    blockers: wrongClient ? ['candidate_binding_mismatch'] : [],
    candidate: { id: ID.candidate, name: candidate.name },
    role: { id: ID.role, title: role.title },
    prior_interview: {
      id: ID.prior,
      attempt_number: 1,
      status: 'Analyzed',
      transcript_present: true,
      recording_present: true,
      report_present: false,
    },
    replacement: null,
    adjudication: null,
  };
  return {
    tracker,
    from(table) {
      if (table === 'candidates') return new FakeQuery({ data: candidate, error: null }, tracker, table);
      if (table === 'roles') return new FakeQuery({ data: role, error: null }, tracker, table);
      return new FakeQuery({ data: null, error: null }, tracker, table);
    },
    async rpc(name, args) {
      tracker.rpc.push({ name, args });
      if (name === 'get_interview_recovery_core_eligibility') return { data: eligibility, error: null };
      if (name === 'authorize_interview_replacement_core') {
        tracker.authorizationCalls += 1;
        if (wrongClient) return { data: null, error: { message: 'prior_interview_binding_mismatch' } };
        return {
          data: [{
            authorization_id: ID.authorization,
            adjudication_id: ID.adjudication,
            prior_interview_id: ID.prior,
            replacement_interview_id: null,
            replayed: tracker.authorizationCalls > 1,
            email_status: tracker.authorizationCalls > 1 ? 'sent' : (args.p_reset_mode === 'reset_and_send' ? 'pending' : 'not_requested'),
            audit_log_id: ID.audit,
          }],
          error: null,
        };
      }
      if (name === 'claim_interview_recovery_email_core') {
        return { data: [{ claimed: true, claim_token: '72000000-0000-4000-8000-000000000010', attempt_count: 1 }], error: null };
      }
      if (name === 'complete_interview_recovery_email_core') {
        return { data: args.p_success ? 'sent' : 'failed', error: null };
      }
      if (name === 'service_supersede_otp_challenges') return { data: 0, error: null };
      if (name === 'service_issue_otp_challenge') {
        tracker.challenges.push(args);
        return { data: [{ challenge_id: args.p_challenge_id, expires_at: '2026-08-10T18:00:00Z' }], error: null };
      }
      if (name === 'service_mark_otp_challenge_delivery') return { data: true, error: null };
      return { data: null, error: { message: `unexpected_rpc:${name}` } };
    },
  };
}

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: ID.actor, email: 'admin@example.test' };
    next();
  });
  app.use('/admin/interview-recovery', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function validPayload(overrides = {}) {
  return {
    client_id: ID.client,
    role_id: ID.role,
    prior_interview_id: ID.prior,
    decision: 'authorize_one_video_replacement',
    reason_code: 'candidate_network_disconnect',
    reason_detail: 'Client confirmed an interrupted call.',
    mode: 'reset_only',
    required_coverage_attested: true,
    client_approval_acknowledged: true,
    idempotency_key: ID.key,
    ...overrides,
  };
}

test('Recovery Core route 1. missing/false feature flag fails closed', async () => {
  const db = createFakeDb();
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => false }), async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/eligibility?client_id=${ID.client}&role_id=${ID.role}`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, 'interview_recovery_core_disabled');
  });
  assert.equal(db.tracker.rpc.length, 0);
  assert.equal(isInterviewRecoveryCoreEnabled({}), false);
  assert.equal(isInterviewRecoveryCoreEnabled({ INTERVIEW_RECOVERY_CORE_ENABLED: 'false' }), false);
});

test('Recovery Core route 2. eligibility is bounded and exposes the enabled state', async () => {
  const db = createFakeDb();
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true }), async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/eligibility?client_id=${ID.client}&role_id=${ID.role}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.feature_enabled, true);
    assert.equal(body.prior_interview.id, ID.prior);
    assert.equal(Object.hasOwn(body.prior_interview, 'transcript'), false);
    assert.equal(Object.hasOwn(body, 'report_content'), false);
  });
});

test('Recovery Core route 3. reason, attestation, and approval are required before the RPC', async () => {
  const db = createFakeDb();
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true }), async (base) => {
    for (const [overrides, code] of [
      [{ reason_code: '' }, 'reset_request_conflict'],
      [{ required_coverage_attested: false }, 'recovery_attestation_required'],
      [{ client_approval_acknowledged: false }, 'client_approval_required'],
      [{ reason_code: 'other', reason_detail: '' }, 'interview_reset_other_detail_required'],
    ]) {
      const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validPayload(overrides)),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, code);
    }
  });
  assert.equal(db.tracker.authorizationCalls, 0);
});

test('Recovery Core route 3a. malformed identifiers, bounded strings, modes, decisions, and booleans fail before DB access', async () => {
  const db = createFakeDb();
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true }), async (base) => {
    const invalidEligibility = await fetch(`${base}/admin/interview-recovery/not-a-uuid/eligibility?client_id=${ID.client}&role_id=${ID.role}`);
    assert.equal(invalidEligibility.status, 400);
    for (const [candidateId, overrides] of [
      ['not-a-uuid', {}],
      [ID.candidate, { client_id: 'not-a-uuid' }],
      [ID.candidate, { role_id: 'not-a-uuid' }],
      [ID.candidate, { prior_interview_id: 'not-a-uuid' }],
      [ID.candidate, { idempotency_key: 'x'.repeat(201) }],
      [ID.candidate, { decision: 'unknown' }],
      [ID.candidate, { mode: 'unknown' }],
      [ID.candidate, { reason_code: 'unknown' }],
      [ID.candidate, { decision: ['authorize_one_video_replacement'] }],
      [ID.candidate, { reason_code: ['candidate_network_disconnect'] }],
      [ID.candidate, { reason_detail: { text: 'not primitive' } }],
      [ID.candidate, { mode: 1 }],
      [ID.candidate, { client_id: [ID.client] }],
      [ID.candidate, { required_coverage_attested: 'true' }],
      [ID.candidate, { client_approval_acknowledged: 1 }],
      [ID.candidate, { reason_detail: null }],
      [ID.candidate, { reason_detail: 'x'.repeat(501) }],
      [ID.candidate, { reason_detail: '😀'.repeat(501) }],
      [ID.candidate, { reason_detail: 'unsafe\u0000value' }],
    ]) {
      const response = await fetch(`${base}/admin/interview-recovery/${candidateId}/authorize`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload(overrides)),
      });
      assert.equal(response.status, 400);
    }
  });
  assert.equal(db.tracker.rpc.length, 0);
});

test('Recovery Core route 4. wrong-client authorization is rejected with bounded scope status', async () => {
  const db = createFakeDb({ wrongClient: true });
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true }), async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'prior_interview_binding_mismatch');
  });
});

test('Recovery Core route 5. reset-only creates no OTP and invokes no email sender', async () => {
  const db = createFakeDb();
  let emailCount = 0;
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true, emailSender: async () => { emailCount += 1; } }), async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload()),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.replacement_interview_id, null);
    assert.equal(body.email_status, 'not_requested');
  });
  assert.equal(emailCount, 0);
  assert.equal(db.tracker.challenges.length, 0);
});

test('Recovery Core route 6. reset-and-send is disabled by default before authorization, OTP, or email', async () => {
  const db = createFakeDb();
  let emailCount = 0;
  await withServer(createInterviewRecoveryRouter({ db, featureEnabled: () => true, emailSender: async () => { emailCount += 1; } }), async (base) => {
    const response = await fetch(`${base}/admin/interview-recovery/${ID.candidate}/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validPayload({ mode: 'reset_and_send' })),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'interview_recovery_email_disabled');
  });
  assert.equal(isInterviewRecoveryCoreEmailEnabled({}), false);
  assert.equal(db.tracker.authorizationCalls, 0);
  assert.equal(emailCount, 0);
  assert.equal(db.tracker.challenges.length, 0);
});

test('Recovery Core route 7. explicitly enabled reset-and-send replay does not duplicate OTP or email', async () => {
  const db = createFakeDb();
  let emailCount = 0;
  const router = createInterviewRecoveryRouter({
    db,
    featureEnabled: () => true,
    emailFeatureEnabled: () => true,
    emailSender: async () => { emailCount += 1; },
  });
  await withServer(router, async (base) => {
    const payload = validPayload({ mode: 'reset_and_send' });
    const request = () => fetch(`${base}/admin/interview-recovery/${ID.candidate}/authorize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const first = await request();
    const second = await request();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).replayed, true);
  });
  assert.equal(emailCount, 1);
  assert.equal(db.tracker.challenges.length, 1);
  assert.equal(db.tracker.rpc.filter((entry) => entry.name === 'claim_interview_recovery_email_core').length, 1);
});

test('Recovery Core service 8. enabled claims use the core RPC and preserve a bounded concurrent response', async () => {
  const previous = process.env.INTERVIEW_RECOVERY_CORE_ENABLED;
  process.env.INTERVIEW_RECOVERY_CORE_ENABLED = 'true';
  let calls = 0;
  const db = {
    async rpc(name) {
      calls += 1;
      return {
        data: [{
          interview_id: 'replacement-1',
          attempt_number: 2,
          authorized_replacement: true,
          start_claimed: calls === 1,
          claim_state: calls === 1 ? 'replacement_created' : 'replacement_start_in_progress',
          recovery_authorization_id: 'authorization-1',
        }],
        error: name === 'claim_candidate_interview_attempt_core' ? null : { message: 'wrong rpc' },
      };
    },
  };
  try {
    const [first, second] = await Promise.all([
      claimInterviewAttempt(db, { candidateId: 'candidate', roleId: 'role', clientId: 'client' }),
      claimInterviewAttempt(db, { candidateId: 'candidate', roleId: 'role', clientId: 'client' }),
    ]);
    assert.equal(first.interview_id, second.interview_id);
    assert.equal([first, second].filter((row) => row.start_claimed).length, 1);
  } finally {
    if (previous === undefined) delete process.env.INTERVIEW_RECOVERY_CORE_ENABLED;
    else process.env.INTERVIEW_RECOVERY_CORE_ENABLED = previous;
  }
});

test('Recovery Core service 9. disabled claims retain the Phase A RPC and no-interview behavior', async () => {
  const previous = process.env.INTERVIEW_RECOVERY_CORE_ENABLED;
  delete process.env.INTERVIEW_RECOVERY_CORE_ENABLED;
  let calledRpc = null;
  const db = {
    async rpc(name) {
      calledRpc = name;
      return { data: [{ interview_id: 'attempt-1', attempt_number: 1, authorized_replacement: false }], error: null };
    },
  };
  try {
    const result = await claimInterviewAttempt(db, { candidateId: 'candidate', roleId: 'role', clientId: 'client' });
    assert.equal(calledRpc, 'claim_candidate_interview_attempt');
    assert.equal(result.interview_id, 'attempt-1');
    assert.equal(result.start_claimed, true);
  } finally {
    if (previous === undefined) delete process.env.INTERVIEW_RECOVERY_CORE_ENABLED;
    else process.env.INTERVIEW_RECOVERY_CORE_ENABLED = previous;
  }
});

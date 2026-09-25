'use strict';

// Availability with credits, and the draw at the moment an interview is used.
//
// The contract being protected: a fixed or usage client sees exactly the numbers
// it saw before this feature existed, a rollover client sees its credits folded
// into what is left, and a role spends its own allowance before any credit.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });

const limitEmails = [];
injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async (args) => { limitEmails.push(args); return { ok: true }; },
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const {
  getRoleInterviewAvailability,
  syncRoleInterviewLimitNotification
} = require(path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js'));
const {
  drawCreditForUsedInterview,
  syncInterviewCreditDraw
} = require(path.join(ROOT, 'src', 'services', 'interviewCredits.js'));

const CLIENT = 'client_1';
const ROLE = 'role_1';
const NOW = '2026-09-21T12:00:00.000Z';

const UNIQUE_KEYS = {
  interview_credits: (row) => (row.revoked_at == null ? `role:${row.source_role_id}` : null),
  interview_credit_draws: (row) => `interview:${row.interview_id}`
};

function makeDb({
  planTier = 'pro',
  billingModel = 'rollover',
  included = 5,
  purchases = [],
  interviews = [],
  credits = [],
  draws = [],
  drawnOffset = 0
} = {}) {
  return createFakeSupabase({
    clients: [{
      id: CLIENT,
      parent_client_id: null,
      email: 'owner@acmedental.example',
      name: 'Acme Dental Group',
      client_admin_name: 'Alex Rivera'
    }],
    client_plan_settings: [{
      client_id: CLIENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 699,
      usage_interview_fee_cents: null,
      rollover_days: 90
    }],
    role_interview_purchases: purchases,
    interviews,
    roles: [{ id: ROLE, client_id: CLIENT, title: 'Hygienist', rollover_drawn_offset: drawnOffset, interview_limit_notified_at: null }],
    interview_credits: credits,
    interview_credit_draws: draws
  }, { unique: UNIQUE_KEYS });
}

const used = (id) => ({ id, client_id: CLIENT, role_id: ROLE, status: 'completed' });
const usedMany = (count, offset = 0) =>
  Array.from({ length: count }, (_, i) => used(`iv_${offset + i + 1}`));

const credit = (overrides = {}) => ({
  id: 'credit_1',
  client_id: CLIENT,
  source_role_id: 'role_other',
  quantity: 4,
  remaining: 4,
  minted_at: '2026-09-01T00:00:00.000Z',
  expires_at: '2026-12-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides
});

const availabilityFor = (db) => getRoleInterviewAvailability({ db, roleId: ROLE, clientId: CLIENT });

// --- the response shape ----------------------------------------------------

test('an Essentials client sees exactly the numbers it saw before credits existed', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 5,
    purchases: [{ client_id: CLIENT, role_id: ROLE, quantity: 2, status: 'paid' }],
    interviews: usedMany(3)
  });

  assert.deepEqual(await availabilityFor(db), {
    included_interviews_per_role: 5,
    purchased_interviews: 2,
    used_interviews: 3,
    remaining_interviews: 4,
    own_remaining_interviews: 4,
    credit_interviews: 0,
    rollover_drawn_offset: 0,
    billing_model: 'fixed'
  });
});

test('an Essentials client is not charged a stray offset even if one is stored', async () => {
  const db = makeDb({ planTier: 'basic', billingModel: 'fixed', included: 5, drawnOffset: 3 });

  const availability = await availabilityFor(db);

  assert.equal(availability.remaining_interviews, 5, 'the offset belongs to the rollover model only');
  assert.equal(availability.rollover_drawn_offset, 0);
});

test('an Enterprise client sees no credits', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 2,
    interviews: usedMany(5),
    credits: [credit()]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.credit_interviews, 0, 'usage clients are invoiced, not credited');
  assert.equal(availability.remaining_interviews, 0);
  assert.equal(availability.billing_model, 'usage');
});

test('a Pro client with no credits sees the same numbers as before', async () => {
  const db = makeDb({ included: 5, interviews: usedMany(2) });

  const availability = await availabilityFor(db);

  assert.equal(availability.remaining_interviews, 3);
  assert.equal(availability.own_remaining_interviews, 3);
  assert.equal(availability.credit_interviews, 0);
  assert.equal(availability.billing_model, 'rollover');
});

test('a Pro client with credits has them folded into what is left', async () => {
  const db = makeDb({
    included: 5,
    interviews: usedMany(2),
    credits: [
      credit({ id: 'c_a', source_role_id: 'role_a', remaining: 4 }),
      credit({ id: 'c_b', source_role_id: 'role_b', remaining: 3 })
    ]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.own_remaining_interviews, 3);
  assert.equal(availability.credit_interviews, 7);
  assert.equal(availability.remaining_interviews, 10);
});

test('a role with its own allowance gone still has its credits', async () => {
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [credit({ remaining: 4 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.own_remaining_interviews, 0);
  assert.equal(availability.remaining_interviews, 4);
});

test('expired, revoked and spent credits count for nothing', async () => {
  const db = makeDb({
    included: 1,
    credits: [
      credit({ id: 'c_expired', source_role_id: 'role_a', expires_at: '2026-01-01T00:00:00.000Z' }),
      credit({ id: 'c_revoked', source_role_id: 'role_b', revoked_at: NOW }),
      credit({ id: 'c_spent', source_role_id: 'role_c', remaining: 0 })
    ]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.credit_interviews, 0);
  assert.equal(availability.remaining_interviews, 1);
});

test('a reopened role gives back its allowance minus what other roles already spent', async () => {
  const db = makeDb({ included: 10, interviews: usedMany(2), drawnOffset: 3 });

  const availability = await availabilityFor(db);

  assert.equal(availability.rollover_drawn_offset, 3);
  assert.equal(availability.own_remaining_interviews, 5, '10 included, 2 used, 3 already spent elsewhere');
  assert.equal(availability.remaining_interviews, 5);
});

test('an offset larger than the allowance leaves zero, never a negative', async () => {
  const db = makeDb({ included: 2, interviews: usedMany(1), drawnOffset: 9 });

  const availability = await availabilityFor(db);

  assert.equal(availability.own_remaining_interviews, 0);
  assert.equal(availability.remaining_interviews, 0);
});

test('a legacy Pro row with no billing model still gets its credits', async () => {
  const db = makeDb({ billingModel: null, included: 1, credits: [credit({ remaining: 2 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.billing_model, 'rollover');
  assert.equal(availability.remaining_interviews, 3);
});

test('every error path still answers with nulls, including the new keys', async () => {
  const db = makeDb();

  for (const args of [
    { db: null, roleId: ROLE, clientId: CLIENT },
    { db, roleId: '', clientId: CLIENT },
    { db, roleId: ROLE, clientId: '' }
  ]) {
    assert.deepEqual(await getRoleInterviewAvailability(args), {
      included_interviews_per_role: null,
      purchased_interviews: null,
      used_interviews: null,
      remaining_interviews: null,
      own_remaining_interviews: null,
      credit_interviews: null,
      rollover_drawn_offset: null,
      billing_model: null
    });
  }
});

// --- consumption order -----------------------------------------------------

async function drawFor(db, interviewId) {
  const availability = await availabilityFor(db);
  return {
    availability,
    result: await syncInterviewCreditDraw({
      db, clientId: CLIENT, roleId: ROLE, interviewId, availability, now: NOW
    })
  };
}

test('an interview inside the role allowance costs no credit', async () => {
  const db = makeDb({ included: 5, interviews: usedMany(3), credits: [credit({ remaining: 4 })] });

  const { result } = await drawFor(db, 'iv_3');

  assert.deepEqual(result.reason, 'own_allowance');
  assert.equal(db.tables.interview_credits[0].remaining, 4);
});

test('the interview that exactly finishes the allowance still costs no credit', async () => {
  const db = makeDb({ included: 3, interviews: usedMany(3), credits: [credit({ remaining: 4 })] });

  const { availability, result } = await drawFor(db, 'iv_3');

  assert.equal(availability.own_remaining_interviews, 0);
  assert.equal(result.drawn, false, 'the role paid for this one itself');
  assert.equal(db.tables.interview_credits[0].remaining, 4);
});

test('the first interview past the allowance draws a credit', async () => {
  const db = makeDb({ included: 3, interviews: usedMany(4), credits: [credit({ remaining: 4 })] });

  const { result } = await drawFor(db, 'iv_4');

  assert.equal(result.drawn, true);
  assert.equal(db.tables.interview_credits[0].remaining, 3);
  assert.equal(db.tables.interview_credit_draws[0].interview_id, 'iv_4');
});

test('paid top-ups are spent before any credit', async () => {
  const db = makeDb({
    included: 2,
    purchases: [{ client_id: CLIENT, role_id: ROLE, quantity: 3, status: 'paid' }],
    interviews: usedMany(5),
    credits: [credit({ remaining: 4 })]
  });

  const { result } = await drawFor(db, 'iv_5');

  assert.equal(result.drawn, false, '2 included + 3 purchased covers all five');
  assert.equal(db.tables.interview_credits[0].remaining, 4);
});

test('a reopened role draws sooner, because part of its allowance is already spent', async () => {
  const db = makeDb({ included: 5, drawnOffset: 3, interviews: usedMany(3), credits: [credit({ remaining: 4 })] });

  const { result } = await drawFor(db, 'iv_3');

  assert.equal(result.drawn, true, '5 included less 3 already spent leaves 2, so the third overflows');
  assert.equal(db.tables.interview_credits[0].remaining, 3);
});

test('a late transcript for an interview already drawn for does not draw again', async () => {
  const db = makeDb({ included: 1, interviews: usedMany(3), credits: [credit({ remaining: 4 })] });

  await drawFor(db, 'iv_2');
  const second = await drawFor(db, 'iv_2');

  assert.equal(second.result.drawn, false);
  assert.equal(second.result.reason, 'already_drawn');
  assert.equal(db.tables.interview_credits[0].remaining, 3, 'exactly one unit was spent');
  assert.equal(db.tables.interview_credit_draws.length, 1);
});

test('both webhook paths firing for one interview spend exactly one credit', async () => {
  // The scored-transcript path and the final-transcript reconciliation can both
  // run for the same interview. Each calls the same capacity sync, so the guard
  // that keeps this from double-spending is the unique interview_id on the draw.
  const db = makeDb({ included: 1, interviews: usedMany(3), credits: [credit({ remaining: 4 })] });

  const first = await drawFor(db, 'iv_3');
  const second = await drawFor(db, 'iv_3');

  assert.equal(first.result.drawn, true);
  assert.equal(second.result.drawn, false);
  assert.equal(second.result.reason, 'already_drawn');
  assert.equal(second.result.credit_id, first.result.credit_id, 'the same credit paid for it');
  assert.equal(db.tables.interview_credits[0].remaining, 3, 'exactly one unit left the client');
  assert.equal(db.tables.interview_credit_draws.length, 1);
});

test('an Essentials client never draws, however far over it runs', async () => {
  const db = makeDb({
    planTier: 'basic', billingModel: 'fixed', included: 1,
    interviews: usedMany(9),
    credits: [credit({ remaining: 4 })]
  });

  const { result } = await drawFor(db, 'iv_9');

  assert.equal(result.reason, 'billing_model');
  assert.equal(db.tables.interview_credits[0].remaining, 4);
});

test('an Enterprise client never draws — it is invoiced instead', async () => {
  const db = makeDb({
    planTier: 'enterprise', billingModel: 'usage', included: 1,
    interviews: usedMany(9),
    credits: [credit({ remaining: 4 })]
  });

  const { result } = await drawFor(db, 'iv_9');

  assert.equal(result.reason, 'billing_model');
});

test('a draw is not attempted on an availability that could not be read', async () => {
  const result = await drawCreditForUsedInterview({
    db: makeDb(),
    clientId: CLIENT,
    roleId: ROLE,
    interviewId: 'iv_1',
    availability: {
      included_interviews_per_role: null, purchased_interviews: null,
      used_interviews: null, remaining_interviews: null,
      own_remaining_interviews: null, credit_interviews: null,
      rollover_drawn_offset: null, billing_model: 'rollover'
    },
    now: NOW
  });

  assert.deepEqual(result, { drawn: false, reason: 'availability_unavailable' });
});

test('a draw failure is logged and reports the unadjusted remaining', async () => {
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args);
  let result;
  try {
    result = await syncInterviewCreditDraw({
      db: {
        from() { throw new Error('connection reset'); }
      },
      clientId: CLIENT,
      roleId: ROLE,
      interviewId: 'iv_1',
      availability: {
        included_interviews_per_role: 1, purchased_interviews: 0, used_interviews: 5,
        remaining_interviews: 4, own_remaining_interviews: 0, credit_interviews: 4,
        rollover_drawn_offset: 0, billing_model: 'rollover'
      },
      now: NOW
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.drawn, false);
  assert.equal(result.reason, 'error');
  assert.equal(result.remaining_interviews, 4);
  assert.ok(lines.find(([message]) => message === 'interview_credit_draw_failed'));
});

test('the remaining count handed to the limit notification accounts for the draw', async () => {
  const db = makeDb({ included: 1, interviews: usedMany(2), credits: [credit({ remaining: 4 })] });

  const { availability, result } = await drawFor(db, 'iv_2');

  assert.equal(availability.remaining_interviews, 4);
  assert.equal(result.drawn, true);
  assert.equal(result.remaining_interviews, 3, 'the notification must not be one behind');
});

// --- the limit notification ------------------------------------------------

test('a Pro client with credits is not told the role is full', async () => {
  limitEmails.length = 0;
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [credit({ remaining: 4 })] });

  const availability = await availabilityFor(db);
  await syncRoleInterviewLimitNotification({
    db, roleId: ROLE, clientId: CLIENT,
    remainingInterviews: availability.remaining_interviews,
    roleTitle: 'Hygienist'
  });

  assert.deepEqual(limitEmails, [], 'four credits are still four interviews the client can run');
  assert.equal(db.tables.roles[0].interview_limit_notified_at, null);
});

test('a Pro client with no credits left is still told the role is full', async () => {
  limitEmails.length = 0;
  const db = makeDb({ included: 2, interviews: usedMany(2), credits: [credit({ remaining: 0 })] });

  const availability = await availabilityFor(db);
  await syncRoleInterviewLimitNotification({
    db, roleId: ROLE, clientId: CLIENT,
    remainingInterviews: availability.remaining_interviews,
    roleTitle: 'Hygienist'
  });

  assert.equal(availability.remaining_interviews, 0);
  assert.equal(limitEmails.length, 1);
});

// --- the enforcement points ------------------------------------------------

test('every enforcement point reads the shared function and never recomputes', () => {
  const sites = [
    ['src/routes/public/candidateSubmit.js', 'candidate submission'],
    ['src/routes/public/verifyOtp.js', 'OTP verification'],
    ['src/routes/public/textInterview.js', 'text interview'],
    ['src/routes/public/createTavusInterview.js', 'Tavus interview creation'],
    ['src/routes/admin/roles.js', 'admin roles']
  ];

  for (const [relative, label] of sites) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /getRoleInterviewAvailability/,
      `${label} must read capacity from the shared function`);
    assert.doesNotMatch(
      source,
      /included_interviews_per_role[\s\S]{0,80}?[+-][\s\S]{0,80}?purchased/,
      `${label} must not recompute the availability formula locally`
    );
  }
});

test('both used-transition paths draw before notifying', () => {
  for (const relative of ['src/services/tavusEvents/index.js', 'src/routes/public/textInterview.js']) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(
      source,
      /getRoleInterviewAvailability\(\{[\s\S]*?syncInterviewCreditDraw\(\{[\s\S]*?syncRoleInterviewLimitNotification\(\{[\s\S]*?remainingInterviews: (?:draw|creditDraw)\.remaining_interviews/,
      `${relative} must draw the credit and notify on the adjusted remaining`
    );
  }
});

test('the final-transcript path syncs capacity too, not just the scoring path', () => {
  // application.transcription_ready is answered by reconcileFinalTranscript,
  // which returns from the webhook before the scoring block further down. If the
  // sync is not called there, a video interview never draws a credit.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'services', 'tavusEvents', 'index.js'), 'utf8');

  // queueFinalTranscriptPostProcessing is declared above reconcileFinalTranscript,
  // so the closing anchor has to be its call site inside it.
  const reconcileStart = source.indexOf('async function reconcileFinalTranscript');
  const reconcile = source.slice(
    reconcileStart,
    source.indexOf('queueFinalTranscriptPostProcessing({', reconcileStart)
  );
  assert.ok(reconcile.length, 'expected reconcileFinalTranscript to be present');
  assert.match(reconcile, /await syncInterviewCapacityAfterUse\(\{ interview/,
    'the reconciliation path must recompute capacity once the transcript is authoritative');
  assert.match(reconcile, /finalized\.outcome === 'already_reconciled'/,
    'a retry after a partial failure must still sync');

  const scoring = source.slice(
    source.indexOf('async function applyTranscriptScoringForInterview'),
    source.indexOf('function isEmptyQuestionList')
  );
  assert.match(scoring, /await syncInterviewCapacityAfterUse\(\{ interview/,
    'the scoring path must use the same helper, not its own copy');
});

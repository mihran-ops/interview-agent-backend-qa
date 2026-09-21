'use strict';

// Interview credits for the rollover billing model.
//
// A Pro client that closes a role keeps whatever allowance the role did not use:
// it is minted as a credit the client can spend on any other role until it
// expires. Reopening the role gives its own allowance back, so the credit is
// revoked — but anything already spent from it cannot be taken back from the
// clients who spent it, so that amount is recorded against the role instead.
//
// Every draw is one row keyed by interview_id, so a redelivered event or a late
// transcript cannot spend the same interview twice.

const { getRoleInterviewAvailability } = require('./roleInterviewAvailability');
const { resolveBillingModel } = require('./billingModel');

const ROLLOVER_BILLING_MODEL = 'rollover';
const DRAW_QUANTITY = 1;

// A conditional decrement can lose to a concurrent draw on the same credit. One
// extra pass over freshly read credits is enough to absorb that without letting a
// contended credit spin.
const DRAW_PASSES = 2;

function isUniqueViolation(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key value');
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nowIso(now) {
  return toIso(now) || new Date().toISOString();
}

function addDaysToIso(isoValue, days) {
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

async function findLiveCreditForRole(db, roleId) {
  const { data, error } = await db
    .from('interview_credits')
    .select('id,client_id,source_role_id,quantity,remaining,minted_at,expires_at,revoked_at')
    .eq('source_role_id', roleId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview credit lookup failed');
  return data || null;
}

// Mints the unused part of a closed role's allowance as client credit. Only the
// rollover model mints; every other model lets the allowance lapse.
async function mintCreditForClosedRole({ db, clientId, roleId, closedAt, now } = {}) {
  if (!db || !clientId || !roleId) return { minted: false, reason: 'invalid_request' };

  const existing = await findLiveCreditForRole(db, roleId);
  if (existing) return { minted: false, reason: 'already_minted', credit: existing };

  const billing = await resolveBillingModel({ db, clientId });
  if (billing.billing_model !== ROLLOVER_BILLING_MODEL) {
    return { minted: false, reason: 'billing_model' };
  }

  const availability = await getRoleInterviewAvailability({ db, roleId, clientId });
  // own_remaining_interviews excludes credits, so a credit can never be minted
  // out of another credit. It does not exist until the availability service
  // reports it, and remaining_interviews is the same number until then.
  const leftover = parseWholeNonNegative(
    availability?.own_remaining_interviews ?? availability?.remaining_interviews
  );
  if (leftover == null) return { minted: false, reason: 'availability_unavailable' };
  if (leftover <= 0) return { minted: false, reason: 'no_leftover' };

  const mintedAt = nowIso(now);
  const expiresAt = addDaysToIso(toIso(closedAt) || mintedAt, billing.rollover_days);
  if (!expiresAt) return { minted: false, reason: 'invalid_expiry' };

  const { data, error } = await db
    .from('interview_credits')
    .insert({
      client_id: clientId,
      source_role_id: roleId,
      quantity: leftover,
      remaining: leftover,
      minted_at: mintedAt,
      expires_at: expiresAt
    })
    .select('id,client_id,source_role_id,quantity,remaining,minted_at,expires_at,revoked_at')
    .maybeSingle();

  if (error) {
    // Two closes racing: the partial unique index lets exactly one through.
    if (isUniqueViolation(error)) {
      const winner = await findLiveCreditForRole(db, roleId);
      if (winner) return { minted: false, reason: 'already_minted', credit: winner };
    }
    throw new Error(error.message || 'Interview credit mint failed');
  }

  return { minted: true, credit: data, quantity: leftover, expires_at: expiresAt };
}

// Revokes a reopened role's credit. Draws already taken from it stay spent, so
// the count is added to the role's offset and the role's own allowance is
// reduced by that much for as long as the role stays open.
async function revokeCreditForReopenedRole({ db, roleId, now } = {}) {
  if (!db || !roleId) return { revoked: false, reason: 'invalid_request', drawn_count: 0 };

  const credit = await findLiveCreditForRole(db, roleId);
  if (!credit) return { revoked: false, reason: 'no_credit', drawn_count: 0 };

  const drawnCount = Math.max(0, Number(credit.quantity || 0) - Number(credit.remaining || 0));
  const revokedAt = nowIso(now);

  const { data: revoked, error: revokeError } = await db
    .from('interview_credits')
    .update({ revoked_at: revokedAt, updated_at: revokedAt })
    .eq('id', credit.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (revokeError) throw new Error(revokeError.message || 'Interview credit revoke failed');
  if (!revoked) return { revoked: false, reason: 'already_revoked', drawn_count: 0 };

  if (drawnCount > 0) {
    // Offsets accumulate: a role can be closed and reopened more than once, and
    // each cycle's spent credit stays spent.
    const { data: role, error: roleError } = await db
      .from('roles')
      .select('rollover_drawn_offset')
      .eq('id', roleId)
      .maybeSingle();
    if (roleError) throw new Error(roleError.message || 'Role offset lookup failed');

    const currentOffset = parseWholeNonNegative(role?.rollover_drawn_offset) ?? 0;
    const { error: offsetError } = await db
      .from('roles')
      .update({ rollover_drawn_offset: currentOffset + drawnCount })
      .eq('id', roleId);
    if (offsetError) throw new Error(offsetError.message || 'Role offset update failed');
  }

  return { revoked: true, credit_id: credit.id, drawn_count: drawnCount };
}

// Credits the client can spend right now, soonest to expire first.
async function listAvailableCredits({ db, clientId, now } = {}) {
  if (!db || !clientId) return [];

  const { data, error } = await db
    .from('interview_credits')
    .select('id,client_id,source_role_id,quantity,remaining,minted_at,expires_at')
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .gt('remaining', 0)
    .gt('expires_at', nowIso(now))
    .order('expires_at', { ascending: true });
  if (error) throw new Error(error.message || 'Interview credit list failed');
  return data || [];
}

async function findDrawForInterview(db, interviewId) {
  const { data, error } = await db
    .from('interview_credit_draws')
    .select('id,credit_id,interview_id')
    .eq('interview_id', interviewId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Interview credit draw lookup failed');
  return data || null;
}

// Takes one interview from the earliest-expiring credit the client still has.
// The decrement is conditional on the value that was read, so a concurrent draw
// loses rather than over-spending the credit.
async function drawCredit({ db, clientId, roleId, interviewId, now } = {}) {
  if (!db || !clientId || !roleId || !interviewId) {
    return { drawn: false, reason: 'invalid_request' };
  }

  const existingDraw = await findDrawForInterview(db, interviewId);
  if (existingDraw) {
    return { drawn: false, reason: 'already_drawn', credit_id: existingDraw.credit_id };
  }

  let sawContention = false;
  for (let pass = 0; pass < DRAW_PASSES; pass += 1) {
    const credits = await listAvailableCredits({ db, clientId, now });
    if (!credits.length) return { drawn: false, reason: 'no_credits' };

    sawContention = false;
    for (const credit of credits) {
      const remaining = parseWholeNonNegative(credit.remaining);
      if (remaining == null || remaining <= 0) continue;

      const decrementedAt = nowIso(now);
      const { data: decremented, error: decrementError } = await db
        .from('interview_credits')
        .update({ remaining: remaining - 1, updated_at: decrementedAt })
        .eq('id', credit.id)
        .eq('remaining', remaining)
        .is('revoked_at', null)
        .select('id')
        .maybeSingle();
      if (decrementError) throw new Error(decrementError.message || 'Interview credit draw failed');
      if (!decremented) {
        // Someone else moved this credit between the read and the write.
        sawContention = true;
        continue;
      }

      const { error: drawError } = await db
        .from('interview_credit_draws')
        .insert({
          credit_id: credit.id,
          client_id: clientId,
          role_id: roleId,
          interview_id: interviewId,
          quantity: DRAW_QUANTITY,
          drawn_at: decrementedAt
        });

      if (drawError) {
        // The interview was drawn for concurrently. Give the unit straight back
        // rather than leaving the client short.
        await db
          .from('interview_credits')
          .update({ remaining, updated_at: decrementedAt })
          .eq('id', credit.id)
          .eq('remaining', remaining - 1);
        if (isUniqueViolation(drawError)) {
          return { drawn: false, reason: 'already_drawn', credit_id: credit.id };
        }
        throw new Error(drawError.message || 'Interview credit draw failed');
      }

      return { drawn: true, credit_id: credit.id, remaining: remaining - 1 };
    }

    if (!sawContention) break;
  }

  return { drawn: false, reason: sawContention ? 'contended' : 'no_credits' };
}

// Called by both role-status routes after the status change has been written.
// Credits are an accounting side effect of closing or reopening a role, never a
// reason to refuse the change, so every failure here is logged and swallowed.
async function syncRoleCreditsForStatusChange({ db, clientId, roleId, status, closedAt, now } = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  try {
    if (normalizedStatus === 'inactive') {
      return await mintCreditForClosedRole({ db, clientId, roleId, closedAt, now });
    }
    if (normalizedStatus === 'active') {
      return await revokeCreditForReopenedRole({ db, roleId, now });
    }
    return { skipped: true, reason: 'status' };
  } catch (e) {
    console.error('interview_credit_sync_failed', {
      client_id: clientId || null,
      role_id: roleId || null,
      status: normalizedStatus || null,
      error: e?.message || String(e)
    });
    return { skipped: true, reason: 'error' };
  }
}

module.exports = {
  ROLLOVER_BILLING_MODEL,
  drawCredit,
  listAvailableCredits,
  mintCreditForClosedRole,
  revokeCreditForReopenedRole,
  syncRoleCreditsForStatusChange
};

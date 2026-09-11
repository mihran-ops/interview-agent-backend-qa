'use strict';

const crypto = require('crypto');
const { writeAutomationActionEvent } = require('./automationActions');

const DEFAULT_EXPIRATION_HOURS = 72;
const MAX_EXPIRATION_HOURS = 168;

const TOKEN_SELECT = [
  'id',
  'action_id',
  'client_id',
  'token_hash',
  'token_purpose',
  'state',
  'recipient_user_id',
  'recipient_email',
  'expires_at',
  'used_at',
  'last_viewed_at',
  'view_count',
  'rejected_at',
  'request_id',
  'created_at',
  'updated_at'
].join(',');

const ACTION_SELECT = [
  'id',
  'evaluation_id',
  'rule_id',
  'rule_version',
  'client_id',
  'role_id',
  'candidate_id',
  'report_id',
  'interview_id',
  'action_type',
  'state',
  'idempotency_key',
  'candidate_snapshot',
  'action_snapshot',
  'approved_by_user_id',
  'approved_by_email',
  'approved_at',
  'rejected_at',
  'canceled_at',
  'sent_at',
  'failed_at',
  'last_error',
  'send_attempt_count',
  'created_at',
  'updated_at'
].join(',');

function approvalTokenError(code, detail, status = 400, hint = null) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || null;
  err.status = status;
  err.hint = hint;
  return err;
}

function requireDb(db) {
  if (!db || typeof db.from !== 'function') {
    throw approvalTokenError('db_required', 'A Supabase client is required.', 500);
  }
}

function cleanId(value) {
  return String(value || '').trim() || null;
}

function cleanEmail(value) {
  return String(value || '').trim() || null;
}

function normalizeExpirationHours(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_EXPIRATION_HOURS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw approvalTokenError(
      'invalid_approval_token_expiration',
      'expiresInHours must be a positive number.',
      400
    );
  }
  return Math.max(1, Math.min(MAX_EXPIRATION_HOURS, Math.floor(hours)));
}

function generateApprovalToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashApprovalToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function isExpired(tokenRow, now = new Date()) {
  const expiresAt = new Date(tokenRow?.expires_at || 0);
  return !Number.isFinite(expiresAt.getTime()) || expiresAt <= now;
}

async function createApprovalTokenForAction({
  db,
  action,
  recipientUserId = null,
  recipientEmail = null,
  expiresInHours,
  requestId = null
} = {}) {
  requireDb(db);
  if (!action?.id) {
    throw approvalTokenError('automation_action_required', 'automation action is required.', 400);
  }
  if (action.state !== 'pending_approval') {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can receive approval tokens.',
      409
    );
  }

  const token = generateApprovalToken();
  const tokenHash = hashApprovalToken(token);
  const hours = normalizeExpirationHours(expiresInHours);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('automation_action_approval_tokens')
    .insert({
      action_id: action.id,
      client_id: action.client_id,
      token_hash: tokenHash,
      token_purpose: 'manager_review',
      state: 'active',
      recipient_user_id: cleanId(recipientUserId),
      recipient_email: cleanEmail(recipientEmail),
      expires_at: expiresAt,
      request_id: requestId || null
    })
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (error) {
    throw approvalTokenError(
      String(error.code || '') === '23505'
        ? 'automation_approval_token_conflict'
        : 'automation_approval_token_create_failed',
      error.message || 'Approval token create failed.',
      String(error.code || '') === '23505' ? 409 : 500,
      error.hint || null
    );
  }

  return {
    token,
    tokenRow: data || null,
    expires_at: data?.expires_at || expiresAt
  };
}

async function createDigestApprovalTokenForAction({
  db,
  action,
  recipientUserId = null,
  recipientEmail = null,
  expiresInHours,
  requestId = null
} = {}) {
  requireDb(db);
  if (!action?.id) {
    throw approvalTokenError('automation_action_required', 'automation action is required.', 400);
  }
  if (action.state !== 'pending_approval') {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can receive approval tokens.',
      409
    );
  }

  // Raw token values are not stored, so digest links require a fresh active token.
  const now = new Date().toISOString();
  const { error: revokeError } = await db
    .from('automation_action_approval_tokens')
    .update({
      state: 'revoked',
      request_id: requestId || null,
      updated_at: now
    })
    .eq('action_id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'active');

  if (revokeError) {
    throw approvalTokenError(
      'automation_approval_token_rotate_failed',
      revokeError.message || 'Approval token rotate failed.',
      500,
      revokeError.hint || null
    );
  }

  return createApprovalTokenForAction({
    db,
    action,
    recipientUserId,
    recipientEmail,
    expiresInHours,
    requestId
  });
}

async function loadApprovalTokenContext({ db, token } = {}) {
  requireDb(db);
  const rawToken = String(token || '').trim();
  if (rawToken.length < 20) {
    return { valid: false, reason: 'invalid', tokenRow: null, action: null };
  }

  const { data: tokenRow, error: tokenError } = await db
    .from('automation_action_approval_tokens')
    .select(TOKEN_SELECT)
    .eq('token_hash', hashApprovalToken(rawToken))
    .maybeSingle();

  if (tokenError) {
    throw approvalTokenError(
      'automation_approval_token_lookup_failed',
      tokenError.message || 'Approval token lookup failed.',
      500,
      tokenError.hint || null
    );
  }
  if (!tokenRow) {
    return { valid: false, reason: 'invalid', tokenRow: null, action: null };
  }
  if (tokenRow.state !== 'active') {
    return { valid: false, reason: tokenRow.state || 'invalid', tokenRow, action: null };
  }
  if (isExpired(tokenRow)) {
    return { valid: false, reason: 'expired', tokenRow, action: null };
  }

  const { data: action, error: actionError } = await db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('id', tokenRow.action_id)
    .eq('client_id', tokenRow.client_id)
    .maybeSingle();

  if (actionError) {
    throw approvalTokenError(
      'automation_action_lookup_failed',
      actionError.message || 'Automation action lookup failed.',
      500,
      actionError.hint || null
    );
  }
  if (!action) {
    return { valid: false, reason: 'invalid', tokenRow, action: null };
  }
  if (action.state !== 'pending_approval') {
    return { valid: false, reason: action.state === 'rejected' ? 'rejected' : 'invalid', tokenRow, action };
  }

  return { valid: true, reason: null, tokenRow, action };
}

async function markApprovalTokenViewed({ db, tokenRow, requestId = null } = {}) {
  requireDb(db);
  const tokenId = cleanId(tokenRow?.id);
  if (!tokenId) {
    throw approvalTokenError('approval_token_required', 'approval token is required.', 400);
  }

  const now = new Date().toISOString();
  const currentViewCount = Number(tokenRow?.view_count || 0);
  const nextViewCount = Math.max(0, Number.isFinite(currentViewCount) ? currentViewCount : 0) + 1;
  const { data, error } = await db
    .from('automation_action_approval_tokens')
    .update({
      last_viewed_at: now,
      view_count: nextViewCount,
      request_id: requestId || tokenRow.request_id || null,
      updated_at: now
    })
    .eq('id', tokenId)
    .eq('state', 'active')
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (error) {
    throw approvalTokenError(
      'automation_approval_token_view_update_failed',
      error.message || 'Approval token view update failed.',
      500,
      error.hint || null
    );
  }
  return data || tokenRow;
}

async function rejectActionFromApprovalToken({
  db,
  tokenRow,
  action,
  actor = { type: 'system' },
  requestId = null
} = {}) {
  requireDb(db);
  if (!tokenRow?.id || tokenRow.state !== 'active') {
    throw approvalTokenError(
      'invalid_approval_token',
      'This approval link is invalid or no longer available.',
      404
    );
  }
  if (!action?.id || action.state !== 'pending_approval') {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can be rejected.',
      409
    );
  }

  const now = new Date().toISOString();
  const { data: updatedToken, error: tokenError } = await db
    .from('automation_action_approval_tokens')
    .update({
      state: 'rejected',
      rejected_at: now,
      request_id: requestId || tokenRow.request_id || null,
      updated_at: now
    })
    .eq('id', tokenRow.id)
    .eq('state', 'active')
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (tokenError) {
    throw approvalTokenError(
      'automation_approval_token_reject_failed',
      tokenError.message || 'Approval token reject failed.',
      500,
      tokenError.hint || null
    );
  }
  if (!updatedToken) {
    throw approvalTokenError(
      'automation_approval_token_reject_conflict',
      'Approval token could not be marked rejected.',
      409
    );
  }

  const { data: updatedAction, error: actionError } = await db
    .from('automation_actions')
    .update({
      state: 'rejected',
      rejected_at: now,
      updated_at: now
    })
    .eq('id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'pending_approval')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (actionError) {
    throw approvalTokenError(
      'automation_action_reject_failed',
      actionError.message || 'Automation action reject failed.',
      500,
      actionError.hint || null
    );
  }
  if (!updatedAction) {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can be rejected.',
      409
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: updatedAction.id,
    clientId: updatedAction.client_id,
    eventType: 'action_rejected_from_approval_token',
    fromState: 'pending_approval',
    toState: 'rejected',
    actor,
    requestId,
    metadata: {
      approval_token_id: tokenRow.id,
      token_purpose: tokenRow.token_purpose || 'manager_review'
    }
  });

  return { action: updatedAction, tokenRow: updatedToken, event };
}

async function confirmActionFromApprovalToken({
  db,
  tokenRow,
  action,
  actor = { type: 'system' },
  requestId = null
} = {}) {
  requireDb(db);
  if (!tokenRow?.id || tokenRow.state !== 'active') {
    throw approvalTokenError(
      'invalid_approval_token',
      'This approval link is invalid or no longer available.',
      404
    );
  }
  if (!action?.id || action.state !== 'pending_approval') {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can be approved.',
      409
    );
  }

  const now = new Date().toISOString();
  const { data: updatedToken, error: tokenError } = await db
    .from('automation_action_approval_tokens')
    .update({
      state: 'used',
      used_at: now,
      request_id: requestId || tokenRow.request_id || null,
      updated_at: now
    })
    .eq('id', tokenRow.id)
    .eq('state', 'active')
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (tokenError) {
    throw approvalTokenError(
      'automation_approval_token_confirm_failed',
      tokenError.message || 'Approval token confirm failed.',
      500,
      tokenError.hint || null
    );
  }
  if (!updatedToken) {
    throw approvalTokenError(
      'approval_token_confirm_conflict',
      'Approval token could not be marked used.',
      409
    );
  }

  const { data: updatedAction, error: actionError } = await db
    .from('automation_actions')
    .update({
      state: 'approved',
      approved_at: now,
      approved_by_user_id: null,
      approved_by_email: cleanEmail(tokenRow.recipient_email),
      updated_at: now
    })
    .eq('id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'pending_approval')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (actionError) {
    throw approvalTokenError(
      'automation_action_approve_failed',
      actionError.message || 'Automation action approve failed.',
      500,
      actionError.hint || null
    );
  }
  if (!updatedAction) {
    throw approvalTokenError(
      'invalid_action_state',
      'Only pending approval actions can be approved.',
      409
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: updatedAction.id,
    clientId: updatedAction.client_id,
    eventType: 'action_approved_from_approval_token',
    fromState: 'pending_approval',
    toState: 'approved',
    actor,
    requestId,
    metadata: {
      approval_token_id: tokenRow.id,
      token_purpose: tokenRow.token_purpose || 'manager_review'
    }
  });

  return { action: updatedAction, tokenRow: updatedToken, event };
}

module.exports = {
  generateApprovalToken,
  hashApprovalToken,
  createApprovalTokenForAction,
  createDigestApprovalTokenForAction,
  loadApprovalTokenContext,
  markApprovalTokenViewed,
  rejectActionFromApprovalToken,
  confirmActionFromApprovalToken
};

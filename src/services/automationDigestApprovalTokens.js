'use strict';

const crypto = require('crypto');

const DEFAULT_EXPIRATION_HOURS = 72;
const MAX_EXPIRATION_HOURS = 168;

const TOKEN_SELECT = [
  'id',
  'delivery_id',
  'client_id',
  'recipient_email',
  'token_hash',
  'token_purpose',
  'state',
  'expires_at',
  'item_salt',
  'last_viewed_at',
  'view_count',
  'request_id',
  'created_at',
  'updated_at'
].join(',');

const DELIVERY_SELECT = [
  'id',
  'client_id',
  'role_id',
  'recipient_email',
  'digest_type',
  'delivery_date',
  'timezone',
  'send_time_local',
  'status',
  'action_count',
  'action_ids',
  'request_id',
  'sent_at',
  'failed_at',
  'last_error',
  'created_at',
  'updated_at'
].join(',');

function digestApprovalTokenError(code, detail, status = 400, hint = null) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || null;
  err.status = status;
  err.hint = hint;
  return err;
}

function requireDb(db) {
  if (!db || typeof db.from !== 'function') {
    throw digestApprovalTokenError('db_required', 'A Supabase client is required.', 500);
  }
}

function cleanId(value) {
  return String(value || '').trim() || null;
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeExpirationHours(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_EXPIRATION_HOURS;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw digestApprovalTokenError(
      'invalid_digest_approval_token_expiration',
      'expiresInHours must be a positive number.',
      400
    );
  }
  return Math.max(1, Math.min(MAX_EXPIRATION_HOURS, Math.floor(hours)));
}

function generateDigestApprovalToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateDigestApprovalItemSalt() {
  return crypto.randomBytes(32).toString('hex');
}

function hashDigestApprovalToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function buildDigestApprovalItemId(itemSalt, actionId) {
  const salt = String(itemSalt || '').trim();
  const id = cleanId(actionId);
  if (!salt || !id) return null;
  return crypto.createHash('sha256').update(`${salt}:${id}`).digest('hex');
}

function resolveDigestApprovalItemId({ itemSalt, actions = [], itemId } = {}) {
  const requested = String(itemId || '').trim();
  if (!requested) return null;
  for (const action of Array.isArray(actions) ? actions : []) {
    if (buildDigestApprovalItemId(itemSalt, action?.id) === requested) return action;
  }
  return null;
}

function isExpired(tokenRow, now = new Date()) {
  const expiresAt = new Date(tokenRow?.expires_at || 0);
  return !Number.isFinite(expiresAt.getTime()) || expiresAt <= now;
}

async function createDigestApprovalTokenForDelivery({
  db,
  delivery,
  expiresInHours,
  requestId = null
} = {}) {
  requireDb(db);
  const deliveryId = cleanId(delivery?.id);
  const clientId = cleanId(delivery?.client_id);
  const recipientEmail = cleanEmail(delivery?.recipient_email);
  if (!deliveryId) {
    throw digestApprovalTokenError('digest_delivery_required', 'digest delivery is required.', 400);
  }
  if (!clientId) {
    throw digestApprovalTokenError('client_id_required', 'client_id is required.', 400);
  }
  if (!recipientEmail) {
    throw digestApprovalTokenError('recipient_email_required', 'recipient_email is required.', 400);
  }

  const token = generateDigestApprovalToken();
  const tokenHash = hashDigestApprovalToken(token);
  const itemSalt = generateDigestApprovalItemSalt();
  const hours = normalizeExpirationHours(expiresInHours);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('automation_digest_approval_tokens')
    .insert({
      delivery_id: deliveryId,
      client_id: clientId,
      recipient_email: recipientEmail,
      token_hash: tokenHash,
      token_purpose: 'pending_approval_digest',
      state: 'active',
      expires_at: expiresAt,
      item_salt: itemSalt,
      request_id: requestId || null
    })
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (error) {
    throw digestApprovalTokenError(
      String(error.code || '') === '23505'
        ? 'automation_digest_approval_token_conflict'
        : 'automation_digest_approval_token_create_failed',
      error.message || 'Digest approval token create failed.',
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

async function revokeDigestApprovalTokenForDelivery({
  db,
  deliveryId,
  requestId = null
} = {}) {
  requireDb(db);
  const cleanDeliveryId = cleanId(deliveryId);
  if (!cleanDeliveryId) {
    throw digestApprovalTokenError('digest_delivery_required', 'digest delivery is required.', 400);
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('automation_digest_approval_tokens')
    .update({
      state: 'revoked',
      request_id: requestId || null,
      updated_at: now
    })
    .eq('delivery_id', cleanDeliveryId)
    .eq('state', 'active')
    .select(TOKEN_SELECT)
    .maybeSingle();

  if (error) {
    throw digestApprovalTokenError(
      'automation_digest_approval_token_revoke_failed',
      error.message || 'Digest approval token revoke failed.',
      500,
      error.hint || null
    );
  }
  return data || null;
}

async function loadDigestApprovalTokenContext({ db, token } = {}) {
  requireDb(db);
  const rawToken = String(token || '').trim();
  if (rawToken.length < 20) {
    return { valid: false, reason: 'invalid', tokenRow: null, delivery: null };
  }

  const { data: tokenRow, error: tokenError } = await db
    .from('automation_digest_approval_tokens')
    .select(TOKEN_SELECT)
    .eq('token_hash', hashDigestApprovalToken(rawToken))
    .maybeSingle();

  if (tokenError) {
    throw digestApprovalTokenError(
      'automation_digest_approval_token_lookup_failed',
      tokenError.message || 'Digest approval token lookup failed.',
      500,
      tokenError.hint || null
    );
  }
  if (!tokenRow) {
    return { valid: false, reason: 'invalid', tokenRow: null, delivery: null };
  }
  if (tokenRow.state !== 'active') {
    return { valid: false, reason: tokenRow.state || 'invalid', tokenRow, delivery: null };
  }
  if (isExpired(tokenRow)) {
    return { valid: false, reason: 'expired', tokenRow, delivery: null };
  }

  const { data: delivery, error: deliveryError } = await db
    .from('automation_digest_deliveries')
    .select(DELIVERY_SELECT)
    .eq('id', tokenRow.delivery_id)
    .eq('client_id', tokenRow.client_id)
    .maybeSingle();

  if (deliveryError) {
    throw digestApprovalTokenError(
      'automation_digest_delivery_lookup_failed',
      deliveryError.message || 'Automation digest delivery lookup failed.',
      500,
      deliveryError.hint || null
    );
  }
  if (!delivery) {
    return { valid: false, reason: 'invalid', tokenRow, delivery: null };
  }
  if (delivery.status !== 'sent') {
    return { valid: false, reason: 'delivery_unavailable', tokenRow, delivery };
  }
  const actionIds = Array.isArray(delivery.action_ids)
    ? delivery.action_ids.map(cleanId).filter(Boolean)
    : [];
  if (actionIds.length === 0) {
    return { valid: false, reason: 'no_actions', tokenRow, delivery };
  }

  return { valid: true, reason: null, tokenRow, delivery };
}

async function markDigestApprovalTokenViewed({ db, tokenRow, requestId = null } = {}) {
  requireDb(db);
  const tokenId = cleanId(tokenRow?.id);
  if (!tokenId) {
    throw digestApprovalTokenError('digest_approval_token_required', 'digest approval token is required.', 400);
  }

  const now = new Date().toISOString();
  const currentViewCount = Number(tokenRow?.view_count || 0);
  const nextViewCount = Math.max(0, Number.isFinite(currentViewCount) ? currentViewCount : 0) + 1;
  const { data, error } = await db
    .from('automation_digest_approval_tokens')
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
    throw digestApprovalTokenError(
      'automation_digest_approval_token_view_update_failed',
      error.message || 'Digest approval token view update failed.',
      500,
      error.hint || null
    );
  }
  return data || tokenRow;
}

module.exports = {
  generateDigestApprovalToken,
  hashDigestApprovalToken,
  buildDigestApprovalItemId,
  resolveDigestApprovalItemId,
  createDigestApprovalTokenForDelivery,
  revokeDigestApprovalTokenForDelivery,
  loadDigestApprovalTokenContext,
  markDigestApprovalTokenViewed
};

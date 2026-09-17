'use strict';


// The automation normalisers, digest builders and approval helpers that sat above
// the routes in routes/automation.js. Moved verbatim, so they still call each
// other directly.

const express = require('express');
const { supabaseAdmin } = require('../../clients/supabase');
const { secretsMatch } = require('../secretCompare');
const mailer = require('../../clients/sendgrid');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  buildClientScopeContext,
  canCreateRolesForClient
} = require('../clientScope');
const {
  evaluateCandidateAutomation,
  normalizeCriteriaConfig,
  stableStringify
} = require('../candidateAutomationEvaluator');
const {
  createPendingAutomationAction,
  listAutomationActions,
  listAutomationActionEvents,
  writeAutomationActionEvent,
  sendApprovedAutomationActionSchedulingEmail
} = require('../automationActions');
const {
  createApprovalTokenForAction,
  loadApprovalTokenContext,
  markApprovalTokenViewed,
  rejectActionFromApprovalToken,
  confirmActionFromApprovalToken
} = require('../automationApprovalTokens');
const {
  buildDigestApprovalItemId,
  createDigestApprovalTokenForDelivery,
  revokeDigestApprovalTokenForDelivery,
  loadDigestApprovalTokenContext,
  markDigestApprovalTokenViewed
} = require('../automationDigestApprovalTokens');

const db = supabaseAdmin;
const DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE = 'America/Denver';
const DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY = 'daily';
const DEFAULT_AUTOMATION_RULE_NAME = 'Automation rule';
const MAX_AUTOMATION_RULE_NAME_LENGTH = 120;
const PENDING_APPROVAL_DIGEST_FREQUENCIES = new Set(['daily', 'weekdays', 'weekly']);
const PENDING_APPROVAL_DIGEST_WEEKLY_DAYS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]);
const MAX_PENDING_APPROVAL_DIGEST_RECIPIENTS = 10;

const RULE_SELECT = [
  'id',
  'name',
  'client_id',
  'role_id',
  'enabled',
  'mode',
  'criteria_config',
  'action_config',
  'digest_config',
  'rule_version',
  'created_by_user_id',
  'created_by_email',
  'updated_by_user_id',
  'updated_by_email',
  'archived_at',
  'created_at',
  'updated_at'
].join(',');

const EVALUATION_SELECT = [
  'id',
  'rule_id',
  'rule_version',
  'client_id',
  'role_id',
  'candidate_id',
  'report_id',
  'interview_id',
  'trigger_source',
  'matched',
  'evaluation_status',
  'criteria_config_snapshot',
  'normalized_candidate_snapshot',
  'match_reasons',
  'non_match_reasons',
  'score_snapshot_hash',
  'idempotency_key',
  'request_id',
  'created_at'
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

const DIGEST_APPROVAL_ACTION_SELECT = [
  'id',
  'client_id',
  'state',
  'candidate_snapshot',
  'created_at',
  'updated_at'
].join(',');

const DIGEST_DELIVERY_SELECT = [
  'id',
  'client_id',
  'role_id',
  'recipient_email',
  'recipient_email_domain',
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
  'created_by_user_id',
  'created_by_email',
  'created_at',
  'updated_at'
].join(',');

function requestId(req) {
  return req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
}

function sendError(res, status, payload = {}) {
  return res.status(status).json({
    error: payload.error || payload.code || 'server_error',
    code: payload.code || payload.error || 'server_error',
    detail: payload.detail || null,
    hint: payload.hint || null,
    request_id: payload.request_id || null
  });
}

function configuredAutomationSchedulerSecret() {
  return String(
    process.env.AUTOMATION_DIGEST_RUNNER_SECRET ||
    process.env.AUTOMATION_DIGEST_CRON_SECRET ||
    process.env.CONTRACTS_CRON_SECRET ||
    ''
  ).trim();
}

function automationSchedulerSecretHeader(req) {
  const headerNames = ['x-cron-secret', 'x-automation-cron-secret', 'x-scheduler-secret'];
  for (const headerName of headerNames) {
    const value = req.get(headerName);
    if (value !== undefined) return String(value || '').trim();
  }
  return null;
}

function validAutomationSchedulerSecret(req) {
  const expected = configuredAutomationSchedulerSecret();
  const provided = automationSchedulerSecretHeader(req);
  return secretsMatch(provided, expected);
}

function automationDigestSchedulerSendEnabled() {
  return ['true', '1', 'yes'].includes(
    String(process.env.AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED || '').trim().toLowerCase()
  );
}

function requireAutomationRunnerAccess(req, res, next) {
  if (automationSchedulerSecretHeader(req) !== null) {
    if (validAutomationSchedulerSecret(req)) {
      req.isAutomationScheduler = true;
      req.isGlobalAdmin = true;
      req.isAdmin = true;
      req.user = { id: null, email: null };
      req.clientScope = {
        user: req.user,
        memberships: [],
        accessibleClientIds: [],
        effectiveClientIds: []
      };
      return next();
    }
    return sendError(res, 401, {
      error: 'unauthorized',
      code: 'unauthorized',
      detail: 'Unauthorized.',
      request_id: requestId(req)
    });
  }
  return requireAuth(req, res, () => withClientScope(req, res, next));
}

function routeError(code, detail, status = 400, hint = null) {
  const err = new Error(detail || code);
  err.status = status;
  err.code = code;
  err.detail = detail || null;
  err.hint = hint;
  return err;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toRequiredId(value, code) {
  const id = String(value || '').trim();
  if (!id) {
    const err = new Error(code);
    err.status = 400;
    err.code = code;
    err.detail = code.replace(/_/g, ' ');
    throw err;
  }
  return id;
}

function normalizeEnabled(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  const err = new Error('enabled must be a boolean.');
  err.status = 400;
  err.code = 'invalid_enabled';
  err.detail = 'enabled must be a boolean.';
  throw err;
}

function normalizeAutomationRuleName(value, { allowOmitted = false } = {}) {
  if (value === undefined) {
    if (allowOmitted) return DEFAULT_AUTOMATION_RULE_NAME;
    throw routeError(
      'automation_rule_name_required',
      'name is required.',
      400
    );
  }
  if (value === null) {
    throw routeError(
      'automation_rule_name_required',
      'name is required.',
      400
    );
  }
  if (typeof value !== 'string') {
    throw routeError(
      'invalid_automation_rule_name',
      'name must be a string.',
      400
    );
  }

  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    throw routeError(
      'automation_rule_name_required',
      'name is required.',
      400
    );
  }
  if (cleaned.length > MAX_AUTOMATION_RULE_NAME_LENGTH) {
    throw routeError(
      'automation_rule_name_too_long',
      `name must be ${MAX_AUTOMATION_RULE_NAME_LENGTH} characters or fewer.`,
      400
    );
  }
  return cleaned;
}

function normalizeJsonObject(value, fieldName, fallback = {}) {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) {
    const err = new Error(`${fieldName} must be a JSON object.`);
    err.status = 400;
    err.code = `invalid_${fieldName}`;
    err.detail = `${fieldName} must be a JSON object.`;
    throw err;
  }
  return value;
}

function normalizeConfigBoolean(value, fieldPath, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  throw routeError(
    `invalid_${fieldPath.replace(/[^\w]+/g, '_')}`,
    `${fieldPath} must be a boolean.`,
    400
  );
}

function normalizeOptionalBoolean(value, fieldName, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === false) return value;
  throw routeError(
    `invalid_${fieldName}`,
    `${fieldName} must be a boolean.`,
    400
  );
}

function buildScopeContext(req) {
  const memberships =
    (Array.isArray(req?.clientScope?.memberships) && req.clientScope.memberships) ||
    (Array.isArray(req?.memberships) && req.memberships) ||
    [];
  const clients = memberships.map((membership) => membership?.client).filter(Boolean);
  return buildClientScopeContext({ memberships, clients });
}

function canConfigureAutomation(req, clientId) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true;
  const id = String(clientId || '').trim();
  if (!id) return false;
  const scopeContext = buildScopeContext(req);
  return canCreateRolesForClient(scopeContext, id);
}

function configurableClientIds(req) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return null;
  const scopeContext = buildScopeContext(req);
  return Array.from(new Set((scopeContext.accessibleClientIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && canCreateRolesForClient(scopeContext, id))));
}

function resolveClientId(req) {
  return String(
    req.query?.client_id ||
    req.body?.client_id ||
    req.client?.id ||
    req.clientScope?.defaultClientId ||
    ''
  ).trim();
}

function cleanUserEmail(req) {
  return String(req?.user?.email || '').trim() || null;
}

function cleanRouteText(value, fallback = null, maxLength = 200) {
  const cleaned = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(value, code, detail) {
  const email = String(value || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    throw routeError(code, detail, 400);
  }
  return email;
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function actorFromRequest(req) {
  return {
    type: req?.isGlobalAdmin === true || req?.isAdmin === true ? 'admin' : 'user',
    userId: req?.user?.id || null,
    email: cleanUserEmail(req)
  };
}

function normalizeLimit(value, fallback = 100, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function loadRoleForClient(roleId, clientId) {
  const { data, error } = await db
    .from('roles')
    .select('id,client_id,title')
    .eq('id', roleId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) {
    const err = new Error(error.message || 'role_lookup_failed');
    err.status = 500;
    err.code = 'role_lookup_failed';
    err.detail = error.message || 'Role lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadCandidateForClient(candidateId, clientId, roleId = null) {
  let query = db
    .from('candidates')
    .select('id,client_id,role_id')
    .eq('id', candidateId)
    .eq('client_id', clientId);
  if (roleId) query = query.eq('role_id', roleId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'candidate_lookup_failed');
    err.status = 500;
    err.code = 'candidate_lookup_failed';
    err.detail = error.message || 'Candidate lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadCandidateForClientRole(candidateId, clientId, roleId) {
  const { data, error } = await db
    .from('candidates')
    .select('id,client_id,role_id')
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .eq('role_id', roleId)
    .maybeSingle();
  if (error) {
    const err = new Error(error.message || 'candidate_lookup_failed');
    err.status = 500;
    err.code = 'candidate_lookup_failed';
    err.detail = error.message || 'Candidate lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadAction(actionId, clientIds = null) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return null;
  let query = db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('id', actionId);
  if (Array.isArray(clientIds)) query = query.in('client_id', clientIds);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'automation_action_lookup_failed');
    err.status = 500;
    err.code = 'automation_action_lookup_failed';
    err.detail = error.message || 'Automation action lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadRule(ruleId, clientIds = null) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return null;
  let query = db
    .from('automation_rules')
    .select(RULE_SELECT)
    .eq('id', ruleId)
    .is('archived_at', null);
  if (Array.isArray(clientIds)) query = query.in('client_id', clientIds);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'automation_rule_lookup_failed');
    err.status = 500;
    err.code = 'automation_rule_lookup_failed';
    err.detail = error.message || 'Automation rule lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

function handleCaughtError(res, req, err, fallbackCode = 'server_error') {
  const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 500;
  const code = err?.code || fallbackCode;
  if (status >= 500) {
    console.error('[automation] unexpected', {
      request_id: requestId(req),
      code,
      error: err?.message || err
    });
  }
  return sendError(res, status, {
    error: status >= 500 ? 'server_error' : code,
    code,
    detail: err?.detail || (status >= 500 ? 'Server error.' : err?.message || null),
    hint: err?.hint || null,
    request_id: requestId(req)
  });
}

function setApprovalNoStore(res) {
  res.set('Cache-Control', 'no-store');
}

function sendApprovalTokenUnavailable(res, req, context = {}) {
  const reason = String(context?.reason || '').trim();
  const expired = reason === 'expired';
  setApprovalNoStore(res);
  return res.status(expired ? 410 : 404).json({
    ok: false,
    error: expired ? 'approval_token_expired' : 'approval_token_invalid',
    code: expired ? 'approval_token_expired' : 'approval_token_invalid',
    detail: expired
      ? 'This approval link has expired or is no longer available.'
      : 'This approval link is invalid or no longer available.',
    request_id: requestId(req)
  });
}

function sendDigestApprovalTokenUnavailable(res, req, context = {}) {
  const reason = String(context?.reason || '').trim();
  const expired = reason === 'expired';
  const unavailable = reason === 'no_actions' || reason === 'delivery_unavailable';
  setApprovalNoStore(res);
  return sendError(res, expired ? 410 : 404, {
    error: expired
      ? 'digest_approval_token_expired'
      : unavailable
        ? 'digest_approval_unavailable'
        : 'digest_approval_token_invalid',
    code: expired
      ? 'digest_approval_token_expired'
      : unavailable
        ? 'digest_approval_unavailable'
        : 'digest_approval_token_invalid',
    detail: expired
      ? 'This review link has expired or is no longer available.'
      : 'This review link is invalid or no longer available.',
    hint: null,
    request_id: requestId(req)
  });
}

function buildApprovalActionSummary({ action, tokenRow } = {}) {
  const snapshot = isPlainObject(action?.candidate_snapshot) ? action.candidate_snapshot : {};
  const cleanText = (value) => String(value || '').trim() || null;
  return {
    state: action?.state || null,
    candidate_name: cleanText(snapshot.candidate_name),
    role_title: cleanText(snapshot.role_title),
    scores: {
      overall_score: snapshot.overall_score ?? null,
      resume_score: snapshot.resume_score ?? null,
      interview_score: snapshot.interview_score ?? null
    },
    expires_at: tokenRow?.expires_at || null
  };
}

function digestApprovalActionIds(delivery = {}) {
  const ids = Array.isArray(delivery.action_ids) ? delivery.action_ids : [];
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function resolveDigestApprovalActionId({ tokenRow, delivery, itemId } = {}) {
  const requested = String(itemId || '').trim();
  if (!requested) return null;
  const matches = digestApprovalActionIds(delivery)
    .filter((actionId) => buildDigestApprovalItemId(tokenRow?.item_salt, actionId) === requested);
  return matches.length === 1 ? matches[0] : null;
}

async function loadDigestApprovalActions(delivery = {}) {
  const actionIds = digestApprovalActionIds(delivery);
  if (actionIds.length === 0) return [];
  const { data, error } = await db
    .from('automation_actions')
    .select(DIGEST_APPROVAL_ACTION_SELECT)
    .eq('client_id', delivery.client_id)
    .in('id', actionIds);

  if (error) {
    throw routeError(
      'automation_digest_approval_actions_lookup_failed',
      error.message || 'Digest approval actions lookup failed.',
      500,
      error.hint || null
    );
  }

  const actionsById = new Map((Array.isArray(data) ? data : [])
    .map((action) => [String(action?.id || ''), action]));
  return actionIds.map((id) => actionsById.get(id)).filter(Boolean);
}

async function loadDigestApprovalActionForItem({ tokenRow, delivery, itemId } = {}) {
  const actionId = resolveDigestApprovalActionId({ tokenRow, delivery, itemId });
  if (!actionId) return null;
  const { data, error } = await db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('id', actionId)
    .eq('client_id', delivery.client_id)
    .maybeSingle();

  if (error) {
    throw routeError(
      'automation_digest_approval_action_lookup_failed',
      error.message || 'Digest approval action lookup failed.',
      500,
      error.hint || null
    );
  }
  return data || null;
}

function digestApprovalPublicStatus(state) {
  const normalized = String(state || '').trim();
  if (normalized === 'pending_approval') return 'pending';
  if (['approved', 'queued', 'sending', 'sent', 'delivered'].includes(normalized)) {
    return 'approved_or_sent';
  }
  if (normalized === 'rejected') return 'rejected';
  if (normalized === 'failed') return 'failed';
  return 'unavailable';
}

function buildDigestApprovalReviewItem({ action, tokenRow } = {}) {
  const snapshot = isPlainObject(action?.candidate_snapshot) ? action.candidate_snapshot : {};
  const status = digestApprovalPublicStatus(action?.state);
  const pending = status === 'pending';
  return {
    item_id: buildDigestApprovalItemId(tokenRow?.item_salt, action?.id),
    candidate_name: cleanRouteText(snapshot.candidate_name, null, 160),
    role_title: cleanRouteText(snapshot.role_title, null, 160),
    scores: {
      overall_score: snapshot.overall_score ?? null,
      resume_score: snapshot.resume_score ?? null,
      interview_score: snapshot.interview_score ?? null
    },
    status,
    can_approve_send: pending,
    can_reject: pending
  };
}

function digestApprovalActionResultStatus(state) {
  const normalized = String(state || '').trim();
  if (normalized === 'pending_approval') return 'pending';
  if (['sent', 'delivered'].includes(normalized)) return 'sent';
  if (normalized === 'rejected') return 'rejected';
  if (normalized === 'failed') return 'failed';
  return 'unavailable';
}

function buildDigestApprovalActionResultItem({ action, tokenRow } = {}) {
  const status = digestApprovalActionResultStatus(action?.state);
  const pending = status === 'pending';
  return {
    item_id: buildDigestApprovalItemId(tokenRow?.item_salt, action?.id),
    status,
    can_approve_send: pending,
    can_reject: pending
  };
}

function buildAutomationActionPublicSummary(action = {}) {
  return {
    id: action?.id || null,
    state: action?.state || null,
    action_type: action?.action_type || null,
    client_id: action?.client_id || null,
    role_id: action?.role_id || null,
    candidate_id: action?.candidate_id || null,
    sent_at: action?.sent_at || null,
    failed_at: action?.failed_at || null,
    last_error: action?.last_error || null,
    send_attempt_count: action?.send_attempt_count ?? null
  };
}

function sendDigestApprovalItemUnavailable(res, req) {
  setApprovalNoStore(res);
  return sendError(res, 404, {
    error: 'digest_approval_item_unavailable',
    code: 'digest_approval_item_unavailable',
    detail: 'This review item is invalid or no longer available.',
    hint: null,
    request_id: requestId(req)
  });
}

function digestApprovalActionConflict(code, detail) {
  return routeError(code, detail || 'This review item is no longer available for this action.', 409);
}

async function markDigestApprovalActionApproved({ action, tokenRow, itemId, requestId: request_id } = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('automation_actions')
    .update({
      state: 'approved',
      approved_at: now,
      approved_by_user_id: null,
      approved_by_email: cleanRouteText(tokenRow?.recipient_email, null, 254),
      updated_at: now
    })
    .eq('id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'pending_approval')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (error) {
    throw routeError(
      'automation_digest_approval_action_approve_failed',
      error.message || 'Digest approval action approve failed.',
      500,
      error.hint || null
    );
  }
  if (!data) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_state_conflict',
      'This review item is already being handled.'
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: data.id,
    clientId: data.client_id,
    eventType: 'action_approved_from_digest_approval_token',
    fromState: 'pending_approval',
    toState: 'approved',
    actor: { type: 'system', email: tokenRow?.recipient_email || null },
    requestId: request_id,
    metadata: {
      digest_approval_token_id: tokenRow?.id || null,
      digest_item_id: itemId || null,
      token_purpose: tokenRow?.token_purpose || 'pending_approval_digest'
    }
  });

  return { action: data, event };
}

async function sendApprovedDigestApprovalAction({ action, tokenRow, requestId: request_id } = {}) {
  try {
    const outcome = await sendApprovedAutomationActionSchedulingEmail({
      db,
      action,
      actor: { type: 'system', email: tokenRow?.recipient_email || null },
      requestId: request_id,
      mailer
    });
    return {
      action: outcome?.action || action,
      emailsSent: outcome?.sent ? 1 : 0
    };
  } catch (err) {
    if (['automation_action_already_sent', 'invalid_action_state'].includes(String(err?.code || ''))) {
      const latest = await loadAction(action.id);
      if (['sent', 'delivered'].includes(String(latest?.state || ''))) {
        return { action: latest, emailsSent: 0 };
      }
      if (['approved', 'queued', 'sending'].includes(String(latest?.state || ''))) {
        throw digestApprovalActionConflict(
          'automation_digest_approval_action_in_progress',
          'This review item is already being handled.'
        );
      }
      if (latest) {
        throw digestApprovalActionConflict(
          'automation_digest_approval_action_unavailable',
          'This review item is no longer available for approval.'
        );
      }
    }
    throw err;
  }
}

async function approveSendDigestApprovalAction({ action, tokenRow, itemId, requestId: request_id } = {}) {
  const state = String(action?.state || '').trim();
  if (['sent', 'delivered'].includes(state)) {
    return { action, emailsSent: 0 };
  }
  if (['sending', 'queued'].includes(state)) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_in_progress',
      'This review item is already being handled.'
    );
  }
  if (['rejected', 'failed', 'canceled', 'skipped_duplicate', 'expired'].includes(state)) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_unavailable',
      'This review item is no longer available for approval.'
    );
  }

  let approvedAction = action;
  if (state === 'pending_approval') {
    const approved = await markDigestApprovalActionApproved({
      action,
      tokenRow,
      itemId,
      requestId: request_id
    });
    approvedAction = approved.action;
  } else if (state !== 'approved') {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_unavailable',
      'This review item is no longer available for approval.'
    );
  }

  return sendApprovedDigestApprovalAction({
    action: approvedAction,
    tokenRow,
    requestId: request_id
  });
}

async function rejectDigestApprovalAction({ action, tokenRow, itemId, requestId: request_id } = {}) {
  const state = String(action?.state || '').trim();
  if (state === 'rejected') {
    return { action };
  }
  if (['sent', 'delivered'].includes(state)) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_already_sent',
      'This review item has already been approved and sent.'
    );
  }
  if (['approved', 'queued', 'sending'].includes(state)) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_in_progress',
      'This review item is already being handled.'
    );
  }
  if (state !== 'pending_approval') {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_unavailable',
      'This review item is no longer available for rejection.'
    );
  }

  const now = new Date().toISOString();
  const { data, error } = await db
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

  if (error) {
    throw routeError(
      'automation_digest_approval_action_reject_failed',
      error.message || 'Digest approval action reject failed.',
      500,
      error.hint || null
    );
  }
  if (!data) {
    throw digestApprovalActionConflict(
      'automation_digest_approval_action_state_conflict',
      'This review item is already being handled.'
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: data.id,
    clientId: data.client_id,
    eventType: 'action_rejected_from_digest_approval_token',
    fromState: 'pending_approval',
    toState: 'rejected',
    actor: { type: 'system', email: tokenRow?.recipient_email || null },
    requestId: request_id,
    metadata: {
      digest_approval_token_id: tokenRow?.id || null,
      digest_item_id: itemId || null,
      token_purpose: tokenRow?.token_purpose || 'pending_approval_digest'
    }
  });

  return { action: data, event };
}

async function loadDigestApprovalContextForItem({ token, itemId } = {}) {
  const context = await loadDigestApprovalTokenContext({ db, token });
  if (!context.valid) return { context, action: null };

  const action = await loadDigestApprovalActionForItem({
    tokenRow: context.tokenRow,
    delivery: context.delivery,
    itemId
  });
  return { context, action };
}

function parseApprovalBaseUrl(rawValue, source, status) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw routeError(
      'invalid_approval_base_url',
      'approval_base_url must be a valid http or https URL.',
      status
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw routeError(
      'invalid_approval_base_url',
      'approval_base_url must be a valid http or https URL.',
      status
    );
  }
  return {
    baseUrl: parsed.href.replace(/\/+$/, ''),
    source
  };
}

function resolveDigestApprovalBaseUrl(value) {
  const requested = String(value || '').trim();
  if (requested) return parseApprovalBaseUrl(requested, 'request', 400);

  const candidates = [
    ['APP_BASE_URL', process.env.APP_BASE_URL],
    ['FRONTEND_URL', process.env.FRONTEND_URL]
  ];
  for (const [source, raw] of candidates) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    try {
      return parseApprovalBaseUrl(trimmed, source, 500);
    } catch (_) {
      continue;
    }
  }

  throw routeError(
    'approval_base_url_unavailable',
    'A valid approval base URL is required before sending a pending approval digest.',
    500
  );
}

function normalizeOptionalApprovalBaseUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return parseApprovalBaseUrl(value, 'digest_config', 400).baseUrl;
}

function normalizeSendTimeLocal(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const cleaned = String(value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cleaned)) {
    throw routeError(
      'invalid_pending_approval_digest_send_time_local',
      'digest_config.pending_approval_digest.send_time_local must use HH:MM 24-hour format.',
      400
    );
  }
  return cleaned;
}

function normalizeDigestTimezone(value) {
  const timezone = String(value || DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE).trim();
  if (!timezone || !isValidTimeZone(timezone)) {
    throw routeError(
      'invalid_pending_approval_digest_timezone',
      'digest_config.pending_approval_digest.timezone must be a valid timezone.',
      400
    );
  }
  return timezone;
}

function normalizeDigestFrequency(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY;
  }
  const frequency = String(value).trim().toLowerCase();
  if (!PENDING_APPROVAL_DIGEST_FREQUENCIES.has(frequency)) {
    throw routeError(
      'invalid_pending_approval_digest_frequency',
      'digest_config.pending_approval_digest.frequency must be daily, weekdays, or weekly.',
      400
    );
  }
  return frequency;
}

function normalizeDigestWeeklyDay(value, frequency) {
  if (frequency !== 'weekly') return undefined;
  if (value === undefined || value === null || String(value).trim() === '') {
    throw routeError(
      'missing_pending_approval_digest_weekly_day',
      'digest_config.pending_approval_digest.weekly_day is required when frequency is weekly.',
      400
    );
  }
  const weeklyDay = String(value).trim().toLowerCase();
  if (!PENDING_APPROVAL_DIGEST_WEEKLY_DAYS.has(weeklyDay)) {
    throw routeError(
      'invalid_pending_approval_digest_weekly_day',
      'digest_config.pending_approval_digest.weekly_day must be a weekday name.',
      400
    );
  }
  return weeklyDay;
}

function normalizePendingApprovalDigestConfig(value = {}) {
  const source = value === undefined ? {} : value;
  if (!isPlainObject(source)) {
    throw routeError(
      'invalid_pending_approval_digest_config',
      'digest_config.pending_approval_digest must be a JSON object.',
      400
    );
  }

  const recipientEmails = [];
  const seenEmails = new Set();
  if (source.recipient_emails !== undefined) {
    if (!Array.isArray(source.recipient_emails)) {
      throw routeError(
        'invalid_pending_approval_digest_recipient_emails',
        'digest_config.pending_approval_digest.recipient_emails must be an array.',
        400
      );
    }
    for (const rawEmail of source.recipient_emails) {
      const email = normalizeEmail(
        rawEmail,
        'invalid_pending_approval_digest_recipient_email',
        'digest_config.pending_approval_digest.recipient_emails must contain valid email addresses.'
      );
      if (!seenEmails.has(email)) {
        seenEmails.add(email);
        recipientEmails.push(email);
      }
    }
    if (recipientEmails.length > MAX_PENDING_APPROVAL_DIGEST_RECIPIENTS) {
      throw routeError(
        'pending_approval_digest_recipient_limit_exceeded',
        'digest_config.pending_approval_digest.recipient_emails must include 10 or fewer unique emails.',
        400
      );
    }
  }

  const recipientNames = {};
  if (source.recipient_names !== undefined) {
    if (!isPlainObject(source.recipient_names)) {
      throw routeError(
        'invalid_pending_approval_digest_recipient_names',
        'digest_config.pending_approval_digest.recipient_names must be a JSON object.',
        400
      );
    }
    for (const [rawEmail, rawName] of Object.entries(source.recipient_names)) {
      const email = normalizeEmail(
        rawEmail,
        'invalid_pending_approval_digest_recipient_name_email',
        'digest_config.pending_approval_digest.recipient_names keys must be valid email addresses.'
      );
      if (typeof rawName !== 'string') {
        throw routeError(
          'invalid_pending_approval_digest_recipient_name',
          'digest_config.pending_approval_digest.recipient_names values must be strings.',
          400
        );
      }
      const name = rawName.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length > 120) {
        throw routeError(
          'pending_approval_digest_recipient_name_too_long',
          'digest_config.pending_approval_digest.recipient_names values must be 120 characters or fewer.',
          400
        );
      }
      if (name) recipientNames[email] = name;
    }
  }

  const normalized = {
    enabled: normalizeConfigBoolean(
      source.enabled,
      'digest_config.pending_approval_digest.enabled',
      false
    ),
    recipient_emails: recipientEmails,
    recipient_names: recipientNames,
    timezone: normalizeDigestTimezone(source.timezone),
    frequency: normalizeDigestFrequency(source.frequency)
  };
  const weeklyDay = normalizeDigestWeeklyDay(source.weekly_day, normalized.frequency);
  if (weeklyDay) normalized.weekly_day = weeklyDay;
  const approvalBaseUrl = normalizeOptionalApprovalBaseUrl(source.approval_base_url);
  if (approvalBaseUrl) normalized.approval_base_url = approvalBaseUrl;
  const sendTimeLocal = normalizeSendTimeLocal(source.send_time_local);
  if (sendTimeLocal) normalized.send_time_local = sendTimeLocal;
  return normalized;
}

function normalizeDigestConfig(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return {
    ...source,
    pending_approval_digest: normalizePendingApprovalDigestConfig(source.pending_approval_digest)
  };
}

function validateNowIso(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw routeError(
      'invalid_now_iso',
      'now_iso must be an ISO date/time string.',
      400
    );
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw routeError(
      'invalid_now_iso',
      'now_iso must be an ISO date/time string.',
      400
    );
  }
  return parsed.toISOString();
}

function getPendingApprovalDigestConfig(rule = {}) {
  const digestConfig = isPlainObject(rule.digest_config) ? rule.digest_config : {};
  const pendingConfig = isPlainObject(digestConfig.pending_approval_digest)
    ? digestConfig.pending_approval_digest
    : null;
  if (!pendingConfig || pendingConfig.enabled !== true) return null;

  const recipientEmails = [];
  const seenEmails = new Set();
  for (const rawEmail of Array.isArray(pendingConfig.recipient_emails) ? pendingConfig.recipient_emails : []) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!isValidEmail(email) || seenEmails.has(email)) continue;
    seenEmails.add(email);
    recipientEmails.push(email);
  }
  if (recipientEmails.length === 0) return null;

  const recipientNames = {};
  const sourceNames = isPlainObject(pendingConfig.recipient_names) ? pendingConfig.recipient_names : {};
  for (const [rawEmail, rawName] of Object.entries(sourceNames)) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!seenEmails.has(email) || typeof rawName !== 'string') continue;
    const name = cleanRouteText(rawName, null, 120);
    if (name) recipientNames[email] = name;
  }

  const timezone = isValidTimeZone(pendingConfig.timezone)
    ? pendingConfig.timezone
    : DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
  const sendTimeLocal = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(pendingConfig.send_time_local || '').trim())
    ? String(pendingConfig.send_time_local).trim()
    : null;
  const approvalBaseUrl = String(pendingConfig.approval_base_url || '').trim() || null;
  const rawFrequency = String(pendingConfig.frequency || DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY).trim().toLowerCase();
  const frequency = PENDING_APPROVAL_DIGEST_FREQUENCIES.has(rawFrequency)
    ? rawFrequency
    : DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY;
  const rawWeeklyDay = String(pendingConfig.weekly_day || '').trim().toLowerCase();
  const weeklyDay = frequency === 'weekly' && PENDING_APPROVAL_DIGEST_WEEKLY_DAYS.has(rawWeeklyDay)
    ? rawWeeklyDay
    : null;

  return {
    recipient_emails: recipientEmails,
    recipient_names: recipientNames,
    approval_base_url: approvalBaseUrl,
    timezone,
    send_time_local: sendTimeLocal,
    frequency,
    weekly_day: weeklyDay
  };
}

function resolvePreviewApprovalBaseUrlOverride(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return parseApprovalBaseUrl(value, 'override', 400);
}

function recipientEmailDomain(email) {
  return String(email || '').trim().toLowerCase().split('@')[1] || null;
}

function sanitizeDeliveryError(value, fallback = 'Pending approval digest email could not be sent.') {
  const cleaned = cleanRouteText(value || fallback, fallback, 500) || fallback;
  return cleaned.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted-email]');
}

function deliveryDateForTimezone(timezone, now = new Date()) {
  const safeTimezone = isValidTimeZone(timezone) ? timezone : DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const partValue = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${partValue('year')}-${partValue('month')}-${partValue('day')}`;
}

function localTimeForTimezone(timezone, now = new Date()) {
  const safeTimezone = isValidTimeZone(timezone) ? timezone : DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const partValue = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${partValue('hour')}:${partValue('minute')}`;
}

function localWeekdayForTimezone(timezone, now = new Date()) {
  const safeTimezone = isValidTimeZone(timezone) ? timezone : DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimezone,
    weekday: 'long'
  }).format(now).trim().toLowerCase();
}

function digestCadenceResponseFields(source = {}) {
  const frequency = PENDING_APPROVAL_DIGEST_FREQUENCIES.has(source.frequency)
    ? source.frequency
    : DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY;
  return frequency === 'weekly'
    ? { frequency, weekly_day: source.weekly_day || null }
    : { frequency };
}

function buildAutomationRuleConfigOptions() {
  return {
    criteria_config: {
      fields: {
        min_overall_score: {
          type: 'number',
          min: 0,
          max: 100,
          nullable: true
        },
        min_resume_score: {
          type: 'number',
          min: 0,
          max: 100,
          nullable: true
        },
        min_interview_score: {
          type: 'number',
          min: 0,
          max: 100,
          nullable: true
        },
        allow_resume_only: {
          type: 'boolean',
          default: false
        },
        require_sufficient_content: {
          type: 'boolean',
          default: true
        }
      }
    },
    action_config: {
      action_types: [
        {
          value: 'send_second_round_scheduling_email',
          label: 'Send second-round scheduling email',
          requires_approval: true,
          fields: {
            second_round_scheduling_url: {
              type: 'url',
              required: true,
              allowed_protocols: ['http', 'https']
            },
            second_round_scheduling_label: {
              type: 'string',
              required: false,
              max_length: 80
            }
          }
        }
      ]
    },
    digest_config: {
      pending_approval_digest: {
        recipient_limit: MAX_PENDING_APPROVAL_DIGEST_RECIPIENTS,
        frequencies: [
          {
            value: 'daily',
            label: 'Daily',
            requires_weekly_day: false
          },
          {
            value: 'weekdays',
            label: 'Weekdays',
            requires_weekly_day: false
          },
          {
            value: 'weekly',
            label: 'Weekly',
            requires_weekly_day: true
          }
        ],
        weekly_days: Array.from(PENDING_APPROVAL_DIGEST_WEEKLY_DAYS),
        default_frequency: DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY,
        default_timezone: DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
        send_time_local_format: 'HH:MM',
        approval_base_url: {
          type: 'url',
          allowed_protocols: ['http', 'https']
        }
      }
    },
    safety: {
      digest_requires_approval: true,
      digest_aggregates_by_recipient: true,
      scheduler_send_requires_env_flag: true,
      candidate_email_send_is_manual_after_approval: true
    }
  };
}

function pendingApprovalDigestDueInfo(config = {}, now = new Date()) {
  const timezone = isValidTimeZone(config.timezone) ? config.timezone : DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
  const sendTimeLocal = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(config.send_time_local || '').trim())
    ? String(config.send_time_local).trim()
    : null;
  const frequency = PENDING_APPROVAL_DIGEST_FREQUENCIES.has(config.frequency)
    ? config.frequency
    : DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY;
  const weeklyDay = frequency === 'weekly' && PENDING_APPROVAL_DIGEST_WEEKLY_DAYS.has(config.weekly_day)
    ? config.weekly_day
    : null;
  const localTime = localTimeForTimezone(timezone, now);
  const localWeekday = localWeekdayForTimezone(timezone, now);
  const cadenceDue =
    frequency === 'daily' ||
    (frequency === 'weekdays' && !['saturday', 'sunday'].includes(localWeekday)) ||
    (frequency === 'weekly' && Boolean(weeklyDay) && localWeekday === weeklyDay);
  return {
    due: cadenceDue && (!sendTimeLocal || localTime >= sendTimeLocal),
    delivery_date: deliveryDateForTimezone(timezone, now),
    local_time: localTime,
    timezone,
    send_time_local: sendTimeLocal,
    frequency,
    weekly_day: weeklyDay
  };
}

function buildUnsentDigestItems(group = {}) {
  return (Array.isArray(group.items) ? group.items : []).map((item) => ({
    ...item.summary,
    approval_url: null,
    approval_expires_at: null
  }));
}

function runnerGroupKey(clientId, recipientEmail) {
  return `${String(clientId || '')}::${String(recipientEmail || '').trim().toLowerCase()}`;
}

function buildPreviewActionSummary(action = {}) {
  const snapshot = isPlainObject(action.candidate_snapshot) ? action.candidate_snapshot : {};
  return {
    id: action.id || null,
    role_id: action.role_id || null,
    candidate_id: action.candidate_id || null,
    candidate_name: cleanRouteText(snapshot.candidate_name, null, 160),
    role_title: cleanRouteText(snapshot.role_title, null, 160),
    created_at: action.created_at || null
  };
}

function buildPendingApprovalDigestPreview({
  rules = [],
  actions = [],
  recipientEmail = null,
  limitPerDigest = 25,
  approvalBaseOverride = null
} = {}) {
  const rulesById = new Map();
  for (const rule of rules) {
    const config = getPendingApprovalDigestConfig(rule);
    if (!config) continue;
    rulesById.set(rule.id, { rule, config });
  }

  const requestedRecipient = recipientEmail ? String(recipientEmail).trim().toLowerCase() : null;
  const groups = new Map();
  const ensureGroup = (email, config) => {
    if (!groups.has(email)) {
      groups.set(email, {
        recipient_email: email,
        recipient_name: config.recipient_names[email] || null,
        approval_base_url_source: approvalBaseOverride
          ? 'override'
          : config.approval_base_url
            ? 'rule_config'
            : 'none',
        timezone: config.timezone || DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
        send_time_local: config.send_time_local || null,
        ...digestCadenceResponseFields(config),
        items: [],
        seenActionIds: new Set()
      });
    }
    const group = groups.get(email);
    if (!group.recipient_name && config.recipient_names[email]) {
      group.recipient_name = config.recipient_names[email];
    }
    if (!approvalBaseOverride && group.approval_base_url_source === 'none' && config.approval_base_url) {
      group.approval_base_url_source = 'rule_config';
    }
    return group;
  };

  for (const action of actions) {
    const ruleContext = rulesById.get(action.rule_id);
    if (!ruleContext) continue;
    const { config } = ruleContext;
    for (const email of config.recipient_emails) {
      if (requestedRecipient && email !== requestedRecipient) continue;
      const group = ensureGroup(email, config);
      if (group.seenActionIds.has(action.id) || group.items.length >= limitPerDigest) continue;
      group.seenActionIds.add(action.id);
      group.items.push(buildPreviewActionSummary(action));
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.recipient_email.localeCompare(b.recipient_email))
    .map((group) => ({
      recipient_email: group.recipient_email,
      recipient_name: group.recipient_name,
      items_count: group.items.length,
      approval_base_url_source: group.approval_base_url_source,
      timezone: group.timezone,
      send_time_local: group.send_time_local,
      ...digestCadenceResponseFields(group),
      items: group.items
    }));
}

function buildConfiguredPendingApprovalDigestGroups({
  rules = [],
  actions = [],
  recipientEmail = null,
  limitPerDigest = 25
} = {}) {
  const rulesById = new Map();
  for (const rule of rules) {
    const config = getPendingApprovalDigestConfig(rule);
    if (!config) continue;
    rulesById.set(rule.id, { rule, config });
  }

  const requestedRecipient = recipientEmail ? String(recipientEmail).trim().toLowerCase() : null;
  const groups = new Map();
  const ensureGroup = (email, rule, config) => {
    const key = runnerGroupKey(rule.client_id, email);
    if (!groups.has(key)) {
      groups.set(key, {
        client_id: rule.client_id || null,
        recipient_email: email,
        recipient_name: config.recipient_names[email] || null,
        timezone: config.timezone || DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
        send_time_local: config.send_time_local || null,
        ...digestCadenceResponseFields(config),
        items: [],
        seenActionIds: new Set()
      });
    }
    const group = groups.get(key);
    if (!group.recipient_name && config.recipient_names[email]) {
      group.recipient_name = config.recipient_names[email];
    }
    return group;
  };

  for (const action of actions) {
    const ruleContext = rulesById.get(action.rule_id);
    if (!ruleContext) continue;
    const { config } = ruleContext;
    for (const email of config.recipient_emails) {
      if (requestedRecipient && email !== requestedRecipient) continue;
      const group = ensureGroup(email, ruleContext.rule, config);
      if (group.seenActionIds.has(action.id) || group.items.length >= limitPerDigest) continue;
      group.seenActionIds.add(action.id);
      group.items.push({
        action,
        config,
        summary: buildPreviewActionSummary(action),
        approvalBase: null
      });
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.items.length > 0)
    .sort((a, b) => a.recipient_email.localeCompare(b.recipient_email));
}

function buildRunnerDigestSeeds({ rules = [], recipientEmail = null, now = new Date() } = {}) {
  const requestedRecipient = recipientEmail ? String(recipientEmail).trim().toLowerCase() : null;
  const seeds = new Map();
  const dueRuleIds = new Set();

  for (const rule of rules) {
    const config = getPendingApprovalDigestConfig(rule);
    if (!config) continue;
    const dueInfo = pendingApprovalDigestDueInfo(config, now);
    if (dueInfo.due) dueRuleIds.add(rule.id);

    for (const email of config.recipient_emails) {
      if (requestedRecipient && email !== requestedRecipient) continue;
      const key = runnerGroupKey(rule.client_id, email);
      if (!seeds.has(key)) {
        seeds.set(key, {
          client_id: rule.client_id || null,
          recipient_email: email,
          recipient_name: config.recipient_names[email] || null,
          timezone: dueInfo.timezone,
          send_time_local: dueInfo.send_time_local,
          delivery_date: dueInfo.delivery_date,
          frequency: dueInfo.frequency,
          weekly_day: dueInfo.weekly_day,
          due_rule_ids: new Set(),
          not_due_rule_ids: new Set()
        });
      }
      const seed = seeds.get(key);
      if (!seed.recipient_name && config.recipient_names[email]) {
        seed.recipient_name = config.recipient_names[email];
      }
      if (dueInfo.due) {
        if (seed.due_rule_ids.size === 0) {
          seed.timezone = dueInfo.timezone;
          seed.send_time_local = dueInfo.send_time_local;
          seed.delivery_date = dueInfo.delivery_date;
          seed.frequency = dueInfo.frequency;
          seed.weekly_day = dueInfo.weekly_day;
        }
        seed.due_rule_ids.add(rule.id);
      } else {
        seed.not_due_rule_ids.add(rule.id);
      }
    }
  }

  return { seeds, dueRuleIds };
}

function attachRunnerSeedMetadata(groups = [], seeds = new Map()) {
  for (const group of groups) {
    const seed = seeds.get(runnerGroupKey(group.client_id, group.recipient_email));
    if (!seed) continue;
    group.timezone = seed.timezone || group.timezone;
    group.send_time_local = seed.send_time_local || null;
    group.delivery_date = seed.delivery_date || null;
    group.frequency = seed.frequency || group.frequency || DEFAULT_PENDING_APPROVAL_DIGEST_FREQUENCY;
    group.weekly_day = group.frequency === 'weekly' ? seed.weekly_day || group.weekly_day || null : null;
    if (!group.recipient_name && seed.recipient_name) group.recipient_name = seed.recipient_name;
  }
}

function annotateConfiguredDigestApprovalBaseSources(groups = [], approvalBaseOverride = null) {
  for (const group of groups) {
    const sources = new Set();
    for (const item of group.items) {
      sources.add(
        approvalBaseOverride
          ? 'override'
          : item.config?.approval_base_url
            ? 'rule_config'
            : 'env'
      );
    }
    group.approval_base_url_source = sources.size === 1 ? Array.from(sources)[0] : 'mixed';
  }
}

function sortDigestResponseItems(items = []) {
  return [...items].sort((a, b) => {
    const emailCompare = String(a.recipient_email || '').localeCompare(String(b.recipient_email || ''));
    if (emailCompare !== 0) return emailCompare;
    return String(a.client_id || '').localeCompare(String(b.client_id || ''));
  });
}

function buildRunnerNoActionDigests({ seeds = new Map(), sendGroups = [] } = {}) {
  const sendKeys = new Set(sendGroups.map((group) => runnerGroupKey(group.client_id, group.recipient_email)));
  return Array.from(seeds.values())
    .filter((seed) => !sendKeys.has(runnerGroupKey(seed.client_id, seed.recipient_email)))
    .map((seed) => ({
      client_id: seed.client_id,
      recipient_email: seed.recipient_email,
      recipient_name: seed.recipient_name,
      delivery_status: seed.due_rule_ids.size > 0 ? 'no_pending_actions' : 'not_due',
      items_count: 0,
      timezone: seed.timezone,
      send_time_local: seed.send_time_local,
      delivery_date: seed.delivery_date,
      ...digestCadenceResponseFields(seed),
      items: []
    }));
}

async function buildRunnerDryRunDigests({ groups = [], roleId = null } = {}) {
  const digests = [];
  let wouldSendCount = 0;
  for (const group of groups) {
    const deliveryDate = group.delivery_date || deliveryDateForTimezone(group.timezone);
    const existingDelivery = await findActiveDigestDelivery({
      clientId: group.client_id,
      roleId: roleId || null,
      recipientEmail: group.recipient_email,
      deliveryDate
    });
    const deliveryStatus = existingDelivery
      ? existingDelivery.status === 'sent' ? 'already_sent' : 'skipped'
      : 'would_send';
    if (deliveryStatus === 'would_send') wouldSendCount += 1;
    digests.push({
      client_id: group.client_id,
      recipient_email: group.recipient_email,
      recipient_name: group.recipient_name,
      delivery_status: deliveryStatus,
      delivery_id: existingDelivery?.id || null,
      items_count: group.items.length,
      approval_base_url_source: group.approval_base_url_source,
      timezone: group.timezone,
      send_time_local: group.send_time_local,
      delivery_date: deliveryDate,
      ...digestCadenceResponseFields(group),
      items: buildUnsentDigestItems(group)
    });
  }
  return { digests, wouldSendCount };
}

function resolveConfiguredDigestApprovalBase({ config, approvalBaseOverride } = {}) {
  if (approvalBaseOverride) return approvalBaseOverride;
  if (config?.approval_base_url) {
    return parseApprovalBaseUrl(config.approval_base_url, 'rule_config', 500);
  }
  return resolveDigestApprovalBaseUrl(null);
}

function prepareConfiguredDigestApprovalBases(groups = [], approvalBaseOverride = null) {
  for (const group of groups) {
    const sources = new Set();
    for (const item of group.items) {
      const approvalBase = resolveConfiguredDigestApprovalBase({
        config: item.config,
        approvalBaseOverride
      });
      item.approvalBase = approvalBase;
      sources.add(approvalBase.source);
    }
    group.approval_base_url_source = sources.size === 1 ? Array.from(sources)[0] : 'mixed';
  }
}

async function findActiveDigestDelivery({
  clientId,
  roleId = null,
  recipientEmail,
  deliveryDate
} = {}) {
  let query = db
    .from('automation_digest_deliveries')
    .select(DIGEST_DELIVERY_SELECT)
    .eq('client_id', clientId)
    .eq('recipient_email', recipientEmail)
    .eq('digest_type', 'pending_approval')
    .eq('delivery_date', deliveryDate)
    .in('status', ['sending', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (roleId) query = query.eq('role_id', roleId);
  else query = query.is('role_id', null);

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw routeError(
      'automation_digest_delivery_lookup_failed',
      error.message || 'Automation digest delivery lookup failed.',
      500,
      error.hint || null
    );
  }
  return data || null;
}

async function insertDigestDelivery({
  req,
  clientId,
  roleId = null,
  group,
  deliveryDate,
  requestId: request_id
} = {}) {
  const payload = {
    client_id: clientId,
    role_id: roleId || null,
    recipient_email: group.recipient_email,
    recipient_email_domain: recipientEmailDomain(group.recipient_email),
    digest_type: 'pending_approval',
    delivery_date: deliveryDate,
    timezone: group.timezone || DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
    send_time_local: group.send_time_local || null,
    status: 'sending',
    action_count: 0,
    action_ids: [],
    request_id,
    created_by_user_id: req?.user?.id || null,
    created_by_email: cleanUserEmail(req)
  };

  const { data, error } = await db
    .from('automation_digest_deliveries')
    .insert(payload)
    .select(DIGEST_DELIVERY_SELECT)
    .maybeSingle();

  if (!error) return { delivery: data || null, claimed: true };
  if (String(error.code || '') === '23505') {
    const existing = await findActiveDigestDelivery({
      clientId,
      roleId,
      recipientEmail: group.recipient_email,
      deliveryDate
    });
    return { delivery: existing, claimed: false };
  }
  throw routeError(
    'automation_digest_delivery_insert_failed',
    error.message || 'Automation digest delivery insert failed.',
    500,
    error.hint || null
  );
}

async function markDigestDeliverySent({
  delivery,
  actionIds = [],
  requestId: request_id
} = {}) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('automation_digest_deliveries')
    .update({
      status: 'sent',
      action_count: actionIds.length,
      action_ids: actionIds,
      sent_at: now,
      failed_at: null,
      last_error: null,
      request_id,
      updated_at: now
    })
    .eq('id', delivery.id)
    .eq('status', 'sending')
    .select(DIGEST_DELIVERY_SELECT)
    .maybeSingle();

  if (error) {
    throw routeError(
      'automation_digest_delivery_sent_update_failed',
      error.message || 'Automation digest delivery sent update failed.',
      500,
      error.hint || null
    );
  }
  if (!data) {
    throw routeError(
      'automation_digest_delivery_state_conflict',
      'Automation digest delivery is no longer sending.',
      409
    );
  }
  return data;
}

async function markDigestDeliveryFailed({
  delivery,
  actionIds = [],
  requestId: request_id,
  detail
} = {}) {
  if (!delivery?.id) return null;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('automation_digest_deliveries')
    .update({
      status: 'failed',
      action_count: actionIds.length,
      action_ids: actionIds,
      failed_at: now,
      last_error: sanitizeDeliveryError(detail),
      request_id,
      updated_at: now
    })
    .eq('id', delivery.id)
    .eq('status', 'sending')
    .select(DIGEST_DELIVERY_SELECT)
    .maybeSingle();

  if (error) {
    throw routeError(
      'automation_digest_delivery_failed_update_failed',
      error.message || 'Automation digest delivery failed update failed.',
      500,
      error.hint || null
    );
  }
  return data || delivery;
}

async function sendConfiguredPendingApprovalDigestGroups({
  req,
  clientId = null,
  roleId = null,
  groups = [],
  requestId: request_id
} = {}) {
  const digests = [];
  let emailsSent = 0;
  let digestsSent = 0;
  const actor = actorFromRequest(req);
  for (const group of groups) {
    const groupClientId = group.client_id || clientId;
    const deliveryDate = group.delivery_date || deliveryDateForTimezone(group.timezone);
    const existingDelivery = await findActiveDigestDelivery({
      clientId: groupClientId,
      roleId: roleId || null,
      recipientEmail: group.recipient_email,
      deliveryDate
    });
    if (existingDelivery) {
      digests.push({
        client_id: groupClientId,
        recipient_email: group.recipient_email,
        recipient_name: group.recipient_name,
        items_count: group.items.length,
        approval_base_url_source: group.approval_base_url_source,
        timezone: group.timezone,
        send_time_local: group.send_time_local,
        delivery_date: deliveryDate,
        ...digestCadenceResponseFields(group),
        delivery_status: existingDelivery.status === 'sent' ? 'already_sent' : 'skipped',
        delivery_id: existingDelivery.id,
        items: buildUnsentDigestItems(group)
      });
      continue;
    }

    const claim = await insertDigestDelivery({
      req,
      clientId: groupClientId,
      roleId: roleId || null,
      group,
      deliveryDate,
      requestId: request_id
    });
    const delivery = claim.delivery;
    if (!claim.claimed) {
      digests.push({
        client_id: groupClientId,
        recipient_email: group.recipient_email,
        recipient_name: group.recipient_name,
        items_count: group.items.length,
        approval_base_url_source: group.approval_base_url_source,
        timezone: group.timezone,
        send_time_local: group.send_time_local,
        delivery_date: deliveryDate,
        ...digestCadenceResponseFields(group),
        delivery_status: delivery?.status === 'sent' ? 'already_sent' : 'skipped',
        delivery_id: delivery?.id || null,
        items: buildUnsentDigestItems(group)
      });
      continue;
    }

    const items = [];
    const actionIds = group.items.map((item) => item.action.id).filter(Boolean);
    const digestApprovalBase = group.items.find((item) => item.approvalBase)?.approvalBase;
    if (!digestApprovalBase?.baseUrl) {
      await markDigestDeliveryFailed({
        delivery,
        actionIds,
        requestId: request_id,
        detail: 'A valid approval base URL is required before sending a pending approval digest.'
      });
      throw routeError(
        'approval_base_url_unavailable',
        'A valid approval base URL is required before sending a pending approval digest.',
        500
      );
    }

    let digestTokenOutcome;
    try {
      digestTokenOutcome = await createDigestApprovalTokenForDelivery({
        db,
        delivery,
        requestId: request_id
      });
    } catch (err) {
      await markDigestDeliveryFailed({
        delivery,
        actionIds,
        requestId: request_id,
        detail: err?.detail || err?.message || 'Digest approval token creation failed.'
      });
      throw err;
    }

    const digestApprovalUrl = buildDigestApprovalUrl(digestApprovalBase?.baseUrl, digestTokenOutcome.token);
    for (const item of group.items) {
      items.push({
        ...item.summary,
        approval_expires_at: digestTokenOutcome.expires_at
      });
    }

    try {
      const emailResult = await mailer.sendPendingApprovalDigestEmail(group.recipient_email, {
        recipientName: group.recipient_name,
        clientId: groupClientId,
        roleId: roleId || null,
        digestActionCount: items.length,
        digestApprovalUrl,
        digestApprovalExpiresAt: digestTokenOutcome.expires_at,
        actions: items
      });
      if (emailResult?.skipped) {
        throw routeError(
          'automation_pending_approval_digest_email_not_sent',
          'Pending approval digest email could not be sent.',
          503
        );
      }
    } catch (err) {
      await revokeDigestApprovalTokenForDelivery({
        db,
        deliveryId: delivery.id,
        requestId: request_id
      });
      await markDigestDeliveryFailed({
        delivery,
        actionIds,
        requestId: request_id,
        detail: 'Pending approval digest email could not be sent.'
      });
      if (err?.code === 'automation_pending_approval_digest_email_not_sent') throw err;
      throw routeError(
        'automation_pending_approval_digest_send_failed',
        'Pending approval digest email could not be sent.',
        502
      );
    }

    const sentDelivery = await markDigestDeliverySent({
      delivery,
      actionIds,
      requestId: request_id
    });
    const recipientDomain = group.recipient_email.split('@')[1] || null;
    for (const item of group.items) {
      await writeAutomationActionEvent({
        db,
        actionId: item.action.id,
        clientId: item.action.client_id,
        eventType: 'pending_approval_digest_email_sent',
        fromState: 'pending_approval',
        toState: 'pending_approval',
        actor,
        requestId: request_id,
        metadata: {
          email_category: 'automation_pending_approval_digest',
          digest_recipient_email_domain: recipientDomain,
          digest_action_count: items.length,
          approval_url_source: digestApprovalBase?.source || group.approval_base_url_source || null,
          approval_link_type: 'digest',
          configured_digest: true
        }
      });
    }

    emailsSent += 1;
    digestsSent += 1;
    digests.push({
      client_id: groupClientId,
      recipient_email: group.recipient_email,
      recipient_name: group.recipient_name,
      items_count: items.length,
      approval_base_url_source: group.approval_base_url_source,
      timezone: group.timezone,
      send_time_local: group.send_time_local,
      delivery_date: deliveryDate,
      ...digestCadenceResponseFields(group),
      delivery_status: 'sent',
      delivery_id: sentDelivery?.id || delivery?.id || null,
      items: items.map(({ approval_url_source, ...item }) => item)
    });
  }

  return {
    digests,
    emailsSent,
    digestsSent
  };
}

function buildDigestApprovalUrl(baseUrl, token) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/automation/digest-approval/${encodeURIComponent(String(token || ''))}`;
}

async function persistDryRunEvaluation({
  req,
  rule,
  clientId,
  roleId,
  candidateId,
  result,
  triggerSource = 'dry_run'
}) {
  const payload = {
    rule_id: rule?.id || null,
    rule_version: rule?.rule_version || null,
    client_id: clientId,
    role_id: roleId,
    candidate_id: candidateId,
    report_id: result.reportId || null,
    interview_id: result.interviewId || null,
    trigger_source: triggerSource,
    matched: result.matched,
    evaluation_status: result.evaluationStatus,
    criteria_config_snapshot: result.criteriaConfigSnapshot,
    normalized_candidate_snapshot: result.normalizedCandidateSnapshot,
    match_reasons: result.matchReasons,
    non_match_reasons: result.nonMatchReasons,
    score_snapshot_hash: result.scoreSnapshotHash,
    idempotency_key: result.idempotencyKey,
    request_id: requestId(req)
  };

  const { data, error } = await db
    .from('automation_evaluations')
    .insert(payload)
    .select(EVALUATION_SELECT)
    .maybeSingle();

  if (!error) return { row: data || null, deduped: false };

  if (String(error?.code || '') === '23505') {
    const existing = await db
      .from('automation_evaluations')
      .select(EVALUATION_SELECT)
      .eq('idempotency_key', result.idempotencyKey)
      .maybeSingle();
    if (existing.error) {
      const err = new Error(existing.error.message || 'automation_evaluation_lookup_failed');
      err.status = 500;
      err.code = 'automation_evaluation_lookup_failed';
      err.detail = existing.error.message || 'Automation evaluation lookup failed.';
      err.hint = existing.error.hint || null;
      throw err;
    }
    return { row: existing.data || null, deduped: true };
  }

  const err = new Error(error.message || 'automation_evaluation_insert_failed');
  err.status = 500;
  err.code = 'automation_evaluation_insert_failed';
  err.detail = error.message || 'Automation evaluation insert failed.';
  err.hint = error.hint || null;
  throw err;
}

function evaluationResponse({ result, persisted, rule }) {
  const row = persisted?.row || null;
  return {
    ok: true,
    evaluation: {
      id: row?.id || null,
      rule_id: rule?.id || null,
      rule_version: rule?.rule_version || null,
      matched: result.matched,
      evaluation_status: result.evaluationStatus,
      normalized_candidate_snapshot: result.normalizedCandidateSnapshot,
      criteria_config_snapshot: result.criteriaConfigSnapshot,
      score_snapshot_hash: result.scoreSnapshotHash,
      match_reasons: result.matchReasons,
      non_match_reasons: result.nonMatchReasons,
      report_id: result.reportId || null,
      interview_id: result.interviewId || null,
      idempotency_key: result.idempotencyKey,
      deduped: Boolean(persisted?.deduped),
      created_at: row?.created_at || null
    },
    side_effects: {
      actions_created: 0,
      emails_sent: 0,
      digests_sent: 0
    }
  };
}

module.exports = {
  ACTION_SELECT,
  DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
  RULE_SELECT,
  actorFromRequest,
  annotateConfiguredDigestApprovalBaseSources,
  approveSendDigestApprovalAction,
  attachRunnerSeedMetadata,
  automationDigestSchedulerSendEnabled,
  buildApprovalActionSummary,
  buildAutomationActionPublicSummary,
  buildAutomationRuleConfigOptions,
  buildConfiguredPendingApprovalDigestGroups,
  buildDigestApprovalActionResultItem,
  buildDigestApprovalReviewItem,
  buildDigestApprovalUrl,
  buildPendingApprovalDigestPreview,
  buildPreviewActionSummary,
  buildRunnerDigestSeeds,
  buildRunnerDryRunDigests,
  buildRunnerNoActionDigests,
  canConfigureAutomation,
  cleanRouteText,
  cleanUserEmail,
  configurableClientIds,
  confirmActionFromApprovalToken,
  createApprovalTokenForAction,
  createDigestApprovalTokenForDelivery,
  createPendingAutomationAction,
  db,
  deliveryDateForTimezone,
  evaluateCandidateAutomation,
  evaluationResponse,
  findActiveDigestDelivery,
  getPendingApprovalDigestConfig,
  handleCaughtError,
  insertDigestDelivery,
  isValidEmail,
  listAutomationActionEvents,
  listAutomationActions,
  loadAction,
  loadApprovalTokenContext,
  loadCandidateForClient,
  loadCandidateForClientRole,
  loadDigestApprovalActions,
  loadDigestApprovalContextForItem,
  loadDigestApprovalTokenContext,
  loadRoleForClient,
  loadRule,
  localTimeForTimezone,
  mailer,
  markApprovalTokenViewed,
  markDigestApprovalTokenViewed,
  markDigestDeliveryFailed,
  markDigestDeliverySent,
  normalizeAutomationRuleName,
  normalizeCriteriaConfig,
  normalizeDigestConfig,
  normalizeEmail,
  normalizeEnabled,
  normalizeJsonObject,
  normalizeLimit,
  normalizeOptionalBoolean,
  persistDryRunEvaluation,
  prepareConfiguredDigestApprovalBases,
  rejectActionFromApprovalToken,
  rejectDigestApprovalAction,
  requestId,
  requireAutomationRunnerAccess,
  resolveClientId,
  resolveDigestApprovalBaseUrl,
  resolvePreviewApprovalBaseUrlOverride,
  revokeDigestApprovalTokenForDelivery,
  sendApprovalTokenUnavailable,
  sendApprovedAutomationActionSchedulingEmail,
  sendConfiguredPendingApprovalDigestGroups,
  sendDigestApprovalItemUnavailable,
  sendDigestApprovalTokenUnavailable,
  sendError,
  setApprovalNoStore,
  sortDigestResponseItems,
  stableStringify,
  toRequiredId,
  validateNowIso,
  writeAutomationActionEvent,
};

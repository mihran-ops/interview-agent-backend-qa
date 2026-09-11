'use strict';

const crypto = require('crypto');

const ACTION_TYPE_SECOND_ROUND_EMAIL = 'send_second_round_scheduling_email';
const ACTIVE_SENDABLE_STATES = [
  'pending_approval',
  'approved',
  'queued',
  'sending',
  'sent',
  'delivered'
];

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

const EVENT_SELECT = [
  'id',
  'action_id',
  'client_id',
  'event_type',
  'from_state',
  'to_state',
  'actor_type',
  'actor_user_id',
  'actor_email',
  'request_id',
  'metadata',
  'created_at'
].join(',');

function actionError(code, detail, status = 400, hint = null) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || null;
  err.status = status;
  err.hint = hint;
  return err;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function cleanId(value) {
  return String(value || '').trim() || null;
}

function cleanEmail(value) {
  return String(value || '').trim() || null;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanLimit(value, fallback = 100, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function cleanText(value, maxLength = 200) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeLastError(value, fallback = 'Scheduling email could not be sent.') {
  const cleaned = cleanText(value || fallback, 500).replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted-email]');
  return cleaned || fallback;
}

function normalizeActor(actor = {}) {
  const type = String(actor.type || actor.actor_type || 'system').trim().toLowerCase();
  const actorType = ['system', 'user', 'admin'].includes(type) ? type : 'system';
  return {
    actor_type: actorType,
    actor_user_id: cleanId(actor.userId || actor.user_id || actor.actor_user_id),
    actor_email: cleanEmail(actor.email || actor.actor_email)
  };
}

function shouldDropActionConfigKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return (
    normalized.includes('transcript') ||
    normalized.includes('recording') ||
    normalized.includes('video') ||
    normalized.includes('resume_url') ||
    normalized.includes('resume_file') ||
    normalized.includes('resume_link') ||
    normalized.includes('raw_ai') ||
    normalized.includes('analysis_json') ||
    normalized.includes('vendor') ||
    normalized.includes('payload') ||
    normalized.includes('webhook') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('api_key')
  );
}

function sanitizeJsonValue(value, key = '', depth = 0) {
  if (shouldDropActionConfigKey(key)) return undefined;
  if (depth > 6) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item, '', depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    return Object.keys(value).reduce((acc, childKey) => {
      const sanitized = sanitizeJsonValue(value[childKey], childKey, depth + 1);
      if (sanitized !== undefined) acc[childKey] = sanitized;
      return acc;
    }, {});
  }
  return undefined;
}

function sanitizeActionConfig(actionConfig) {
  if (!isPlainObject(actionConfig)) return {};
  const sanitized = sanitizeJsonValue(actionConfig);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeCandidateSnapshot(snapshot) {
  const source = isPlainObject(snapshot) ? snapshot : {};
  return {
    candidate_id: cleanId(source.candidate_id),
    candidate_name: String(source.candidate_name || '').trim() || null,
    client_id: cleanId(source.client_id),
    role_id: cleanId(source.role_id),
    role_title: String(source.role_title || '').trim() || null,
    overall_score: source.overall_score ?? null,
    resume_score: source.resume_score ?? null,
    interview_score: source.interview_score ?? null,
    interview_status: String(source.interview_status || '').trim() || null,
    report_id: cleanId(source.report_id),
    interview_id: cleanId(source.interview_id),
    content_sufficiency: isPlainObject(source.content_sufficiency) ? source.content_sufficiency : null
  };
}

function actionConfigFromSnapshot(action) {
  const snapshot = isPlainObject(action?.action_snapshot) ? action.action_snapshot : {};
  return isPlainObject(snapshot.action_config) ? snapshot.action_config : {};
}

function schedulingConfigFromAction(action) {
  const actionConfig = actionConfigFromSnapshot(action);
  const source = String(actionConfig.second_round_scheduling_url || '').trim()
    ? 'second_round_scheduling_url'
    : 'scheduling_url';
  const rawUrl = String(actionConfig.second_round_scheduling_url || actionConfig.scheduling_url || '').trim();
  if (!rawUrl) {
    throw actionError(
      'scheduling_url_required',
      'A valid scheduling URL is required before sending this automation action.',
      409
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw actionError(
      'invalid_scheduling_url',
      'Scheduling URL must be a valid http or https URL.',
      409
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw actionError(
      'invalid_scheduling_url',
      'Scheduling URL must be a valid http or https URL.',
      409
    );
  }

  return {
    schedulingUrl: parsed.href,
    schedulingUrlSource: source,
    schedulingLabel: cleanText(actionConfig.second_round_scheduling_label, 80) || 'Schedule next step',
    hiringManagerName: cleanText(actionConfig.hiring_manager_name, 120) || null
  };
}

function requireDb(db) {
  if (!db || typeof db.from !== 'function') {
    throw actionError('db_required', 'A Supabase client is required.', 500);
  }
}

function buildAutomationActionIdempotencyKey({
  ruleId,
  ruleVersion,
  candidateId,
  roleId,
  reportId,
  interviewId,
  actionType
} = {}) {
  return sha256(stableStringify({
    phase: 'candidate_automation_phase2_action',
    action_type: actionType || ACTION_TYPE_SECOND_ROUND_EMAIL,
    rule_id: cleanId(ruleId),
    rule_version: Number.isFinite(Number(ruleVersion)) ? Math.max(1, Math.floor(Number(ruleVersion))) : 1,
    candidate_id: cleanId(candidateId),
    role_id: cleanId(roleId),
    report_id: cleanId(reportId),
    interview_id: cleanId(interviewId)
  }));
}

async function findExistingActionForConflict({
  db,
  idempotencyKey,
  ruleId,
  candidateId,
  actionType
}) {
  const byKey = await db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (byKey.error) {
    throw actionError(
      'automation_action_lookup_failed',
      byKey.error.message || 'Automation action lookup failed.',
      500,
      byKey.error.hint || null
    );
  }
  if (byKey.data) return byKey.data;

  const active = await db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('rule_id', ruleId)
    .eq('candidate_id', candidateId)
    .eq('action_type', actionType)
    .in('state', ACTIVE_SENDABLE_STATES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (active.error) {
    throw actionError(
      'automation_action_lookup_failed',
      active.error.message || 'Automation action lookup failed.',
      500,
      active.error.hint || null
    );
  }
  return active.data || null;
}

async function writeAutomationActionEvent({
  db,
  actionId,
  clientId,
  eventType,
  fromState = null,
  toState = null,
  actor = {},
  requestId = null,
  metadata = null
} = {}) {
  requireDb(db);
  const action_id = cleanId(actionId);
  const client_id = cleanId(clientId);
  const event_type = String(eventType || '').trim();
  if (!action_id) throw actionError('action_id_required', 'action_id is required.', 400);
  if (!client_id) throw actionError('client_id_required', 'client_id is required.', 400);
  if (!event_type) throw actionError('event_type_required', 'event_type is required.', 400);
  if (metadata !== null && metadata !== undefined && !isPlainObject(metadata)) {
    throw actionError('invalid_metadata', 'metadata must be a JSON object.', 400);
  }

  const normalizedActor = normalizeActor(actor);
  const { data, error } = await db
    .from('automation_action_events')
    .insert({
      action_id,
      client_id,
      event_type,
      from_state: fromState || null,
      to_state: toState || null,
      actor_type: normalizedActor.actor_type,
      actor_user_id: normalizedActor.actor_user_id,
      actor_email: normalizedActor.actor_email,
      request_id: requestId || null,
      metadata: metadata || null
    })
    .select(EVENT_SELECT)
    .maybeSingle();

  if (error) {
    throw actionError(
      'automation_action_event_insert_failed',
      error.message || 'Automation action event insert failed.',
      500,
      error.hint || null
    );
  }
  return data || null;
}

async function createPendingAutomationAction({
  db,
  evaluationRow,
  evaluationResult,
  rule,
  actor,
  requestId
} = {}) {
  requireDb(db);
  if (evaluationResult?.matched !== true) {
    return { action: null, skipped: true, reason: 'evaluation_not_matched' };
  }
  if (!rule?.id) {
    throw actionError('rule_required', 'rule is required.', 400);
  }

  const actionType = ACTION_TYPE_SECOND_ROUND_EMAIL;
  const ruleVersion = Number.isFinite(Number(rule.rule_version))
    ? Math.max(1, Math.floor(Number(rule.rule_version)))
    : 1;
  const candidateSnapshot = sanitizeCandidateSnapshot(evaluationResult.normalizedCandidateSnapshot);
  const reportId = cleanId(evaluationResult.reportId || evaluationRow?.report_id || candidateSnapshot.report_id);
  const interviewId = cleanId(evaluationResult.interviewId || evaluationRow?.interview_id || candidateSnapshot.interview_id);
  const idempotencyKey = buildAutomationActionIdempotencyKey({
    ruleId: rule.id,
    ruleVersion,
    candidateId: candidateSnapshot.candidate_id,
    roleId: rule.role_id,
    reportId,
    interviewId,
    actionType
  });
  const actionSnapshot = {
    action_config: sanitizeActionConfig(rule.action_config || {})
  };

  const payload = {
    evaluation_id: cleanId(evaluationRow?.id),
    rule_id: rule.id,
    rule_version: ruleVersion,
    client_id: rule.client_id,
    role_id: rule.role_id,
    candidate_id: candidateSnapshot.candidate_id,
    report_id: reportId,
    interview_id: interviewId,
    action_type: actionType,
    state: 'pending_approval',
    idempotency_key: idempotencyKey,
    candidate_snapshot: candidateSnapshot,
    action_snapshot: actionSnapshot
  };

  const { data, error } = await db
    .from('automation_actions')
    .insert(payload)
    .select(ACTION_SELECT)
    .maybeSingle();

  if (error) {
    if (String(error.code || '') === '23505') {
      const existing = await findExistingActionForConflict({
        db,
        idempotencyKey,
        ruleId: rule.id,
        candidateId: candidateSnapshot.candidate_id,
        actionType
      });
      if (!existing) {
        throw actionError(
          'automation_action_conflict_unresolved',
          'Existing automation action conflict could not be resolved.',
          409
        );
      }
      return { action: existing, skipped: false, deduped: true };
    }
    throw actionError(
      'automation_action_insert_failed',
      error.message || 'Automation action insert failed.',
      500,
      error.hint || null
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: data?.id,
    clientId: rule.client_id,
    eventType: 'pending_approval_created',
    fromState: null,
    toState: 'pending_approval',
    actor,
    requestId,
    metadata: {
      evaluation_id: cleanId(evaluationRow?.id),
      evaluation_status: evaluationResult.evaluationStatus || null
    }
  });

  return { action: data || null, event, skipped: false, deduped: false };
}

async function listAutomationActions({
  db,
  clientId,
  roleId,
  candidateId,
  state,
  limit
} = {}) {
  requireDb(db);
  const client_id = cleanId(clientId);
  if (!client_id) throw actionError('client_id_required', 'client_id is required.', 400);

  let query = db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
    .limit(cleanLimit(limit));

  if (cleanId(roleId)) query = query.eq('role_id', cleanId(roleId));
  if (cleanId(candidateId)) query = query.eq('candidate_id', cleanId(candidateId));
  if (String(state || '').trim()) query = query.eq('state', String(state).trim());

  const { data, error } = await query;
  if (error) {
    throw actionError(
      'automation_actions_lookup_failed',
      error.message || 'Automation actions lookup failed.',
      500,
      error.hint || null
    );
  }
  return data || [];
}

async function listAutomationActionEvents({
  db,
  actionId,
  clientId,
  limit
} = {}) {
  requireDb(db);
  const action_id = cleanId(actionId);
  const client_id = cleanId(clientId);
  if (!action_id) throw actionError('action_id_required', 'action_id is required.', 400);
  if (!client_id) throw actionError('client_id_required', 'client_id is required.', 400);

  const { data, error } = await db
    .from('automation_action_events')
    .select(EVENT_SELECT)
    .eq('action_id', action_id)
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
    .limit(cleanLimit(limit));

  if (error) {
    throw actionError(
      'automation_action_events_lookup_failed',
      error.message || 'Automation action events lookup failed.',
      500,
      error.hint || null
    );
  }
  return data || [];
}

async function loadCandidateForSchedulingAction({ db, action } = {}) {
  const { data, error } = await db
    .from('candidates')
    .select('id,client_id,role_id,name,email')
    .eq('id', action.candidate_id)
    .eq('client_id', action.client_id)
    .eq('role_id', action.role_id)
    .maybeSingle();

  if (error) {
    throw actionError(
      'candidate_lookup_failed',
      'Candidate lookup failed.',
      500,
      error.hint || null
    );
  }
  return data || null;
}

async function loadRoleTitleForSchedulingAction({ db, action } = {}) {
  const snapshot = isPlainObject(action?.candidate_snapshot) ? action.candidate_snapshot : {};
  const snapshotTitle = cleanText(snapshot.role_title, 160);
  if (snapshotTitle) return snapshotTitle;

  const { data, error } = await db
    .from('roles')
    .select('id,client_id,title')
    .eq('id', action.role_id)
    .eq('client_id', action.client_id)
    .maybeSingle();

  if (error) {
    throw actionError(
      'role_lookup_failed',
      'Role lookup failed.',
      500,
      error.hint || null
    );
  }
  return cleanText(data?.title, 160);
}

async function markSchedulingEmailFailed({
  db,
  action,
  actor,
  requestId,
  code,
  detail,
  status = 409
} = {}) {
  const safeDetail = sanitizeLastError(detail);
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('automation_actions')
    .update({
      state: 'failed',
      failed_at: now,
      last_error: safeDetail,
      updated_at: now
    })
    .eq('id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'sending')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (error) {
    throw actionError(
      'automation_action_failure_update_failed',
      'Automation action failure update failed.',
      500,
      error.hint || null
    );
  }
  if (!data) {
    throw actionError(
      'invalid_action_state',
      'Only sending actions can be marked failed.',
      409
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: data.id,
    clientId: data.client_id,
    eventType: 'candidate_scheduling_email_failed',
    fromState: 'sending',
    toState: 'failed',
    actor,
    requestId,
    metadata: {
      reason_code: code || 'scheduling_email_failed'
    }
  });

  const err = actionError(code || 'scheduling_email_failed', safeDetail, status);
  err.action = data;
  err.event = event;
  throw err;
}

async function sendApprovedAutomationActionSchedulingEmail({
  db,
  action,
  actor = {},
  requestId = null,
  mailer = {}
} = {}) {
  requireDb(db);
  if (!action?.id) throw actionError('automation_action_required', 'automation action is required.', 400);
  if (['sent', 'delivered'].includes(action.state)) {
    throw actionError(
      'automation_action_already_sent',
      'This automation action has already been sent.',
      409
    );
  }
  if (action.state !== 'approved') {
    throw actionError(
      'invalid_action_state',
      'Only approved automation actions can send scheduling emails.',
      409
    );
  }

  const sendAttemptCount = Math.max(0, Number(action.send_attempt_count || 0)) + 1;
  const startedAt = new Date().toISOString();
  const { data: sendingAction, error: sendingError } = await db
    .from('automation_actions')
    .update({
      state: 'sending',
      send_attempt_count: sendAttemptCount,
      last_error: null,
      updated_at: startedAt
    })
    .eq('id', action.id)
    .eq('client_id', action.client_id)
    .eq('state', 'approved')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (sendingError) {
    throw actionError(
      'automation_action_send_start_failed',
      'Automation action send start failed.',
      500,
      sendingError.hint || null
    );
  }
  if (!sendingAction) {
    throw actionError(
      'invalid_action_state',
      'Only approved automation actions can send scheduling emails.',
      409
    );
  }

  let schedulingConfig;
  try {
    schedulingConfig = schedulingConfigFromAction(sendingAction);
  } catch (err) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: err?.code || 'invalid_scheduling_url',
      detail: err?.detail || err?.message || 'Scheduling URL is invalid.',
      status: err?.status || 409
    });
  }

  let candidate;
  try {
    candidate = await loadCandidateForSchedulingAction({ db, action: sendingAction });
  } catch (err) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: err?.code || 'candidate_lookup_failed',
      detail: err?.detail || 'Candidate lookup failed.',
      status: err?.status || 500
    });
  }
  if (!candidate || !isValidEmail(candidate.email)) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: 'candidate_email_unavailable',
      detail: 'Candidate email is unavailable for this action.',
      status: 409
    });
  }

  let roleTitle;
  try {
    roleTitle = await loadRoleTitleForSchedulingAction({ db, action: sendingAction });
  } catch (err) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: err?.code || 'role_lookup_failed',
      detail: err?.detail || 'Role lookup failed.',
      status: err?.status || 500
    });
  }
  if (!roleTitle) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: 'role_title_unavailable',
      detail: 'Role title is unavailable for this action.',
      status: 409
    });
  }

  if (!mailer || typeof mailer.sendSecondRoundSchedulingEmail !== 'function') {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: 'scheduling_email_sender_unavailable',
      detail: 'Scheduling email could not be sent.',
      status: 500
    });
  }

  try {
    const emailResult = await mailer.sendSecondRoundSchedulingEmail(candidate.email, {
      candidateName: candidate.name || null,
      roleTitle,
      schedulingUrl: schedulingConfig.schedulingUrl,
      schedulingLabel: schedulingConfig.schedulingLabel,
      hiringManagerName: schedulingConfig.hiringManagerName,
      automationActionId: sendingAction.id,
      clientId: sendingAction.client_id,
      roleId: sendingAction.role_id,
      candidateId: sendingAction.candidate_id
    });
    if (emailResult?.skipped) {
      return markSchedulingEmailFailed({
        db,
        action: sendingAction,
        actor,
        requestId,
        code: 'scheduling_email_not_sent',
        detail: 'Scheduling email could not be sent.',
        status: 503
      });
    }
  } catch (_) {
    return markSchedulingEmailFailed({
      db,
      action: sendingAction,
      actor,
      requestId,
      code: 'scheduling_email_send_failed',
      detail: 'Scheduling email could not be sent.',
      status: 502
    });
  }

  const sentAt = new Date().toISOString();
  const { data: sentAction, error: sentError } = await db
    .from('automation_actions')
    .update({
      state: 'sent',
      sent_at: sentAt,
      last_error: null,
      updated_at: sentAt
    })
    .eq('id', sendingAction.id)
    .eq('client_id', sendingAction.client_id)
    .eq('state', 'sending')
    .select(ACTION_SELECT)
    .maybeSingle();

  if (sentError) {
    throw actionError(
      'automation_action_sent_update_failed',
      'Automation action sent update failed.',
      500,
      sentError.hint || null
    );
  }
  if (!sentAction) {
    throw actionError(
      'invalid_action_state',
      'Only sending actions can be marked sent.',
      409
    );
  }

  const event = await writeAutomationActionEvent({
    db,
    actionId: sentAction.id,
    clientId: sentAction.client_id,
    eventType: 'candidate_scheduling_email_sent',
    fromState: 'sending',
    toState: 'sent',
    actor,
    requestId,
    metadata: {
      email_category: 'candidate_second_round_scheduling',
      scheduling_url_source: schedulingConfig.schedulingUrlSource
    }
  });

  return {
    action: sentAction,
    event,
    sent: true
  };
}

module.exports = {
  buildAutomationActionIdempotencyKey,
  createPendingAutomationAction,
  listAutomationActions,
  listAutomationActionEvents,
  writeAutomationActionEvent,
  sendApprovedAutomationActionSchedulingEmail
};

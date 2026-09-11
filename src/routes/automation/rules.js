'use strict';

// Automation rule CRUD and the dry runs that exercise a rule without sending.

const express = require('express');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  RULE_SELECT,
  actorFromRequest,
  buildAutomationRuleConfigOptions,
  canConfigureAutomation,
  cleanUserEmail,
  configurableClientIds,
  createPendingAutomationAction,
  db,
  evaluateCandidateAutomation,
  evaluationResponse,
  handleCaughtError,
  loadCandidateForClientRole,
  loadRoleForClient,
  loadRule,
  normalizeAutomationRuleName,
  normalizeCriteriaConfig,
  normalizeDigestConfig,
  normalizeEnabled,
  normalizeJsonObject,
  persistDryRunEvaluation,
  requestId,
  resolveClientId,
  sendError,
  stableStringify,
  toRequiredId,
} = require('../../services/automation/index');

const router = express.Router();

router.get('/rules', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = resolveClientId(req);
    const roleId = String(req.query?.role_id || '').trim();
    if (!clientId) {
      return sendError(res, 400, {
        error: 'client_id_required',
        code: 'client_id_required',
        detail: 'client_id is required.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    if (roleId) {
      const role = await loadRoleForClient(roleId, clientId);
      if (!role) {
        return sendError(res, 404, {
          error: 'not_found',
          code: 'role_not_found',
          detail: 'Role not found.',
          request_id
        });
      }
    }

    let query = db
      .from('automation_rules')
      .select(RULE_SELECT)
      .eq('client_id', clientId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (roleId) query = query.eq('role_id', roleId);
    const { data, error } = await query;
    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rules_lookup_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    return res.json({ ok: true, items: data || [], request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rules_lookup_failed');
  }
});

router.get('/rules/config-options', requireAuth, withClientScope, async (req, res) => {
  return res.json({
    ok: true,
    item: buildAutomationRuleConfigOptions(),
    request_id: requestId(req)
  });
});

router.post('/rules', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = toRequiredId(req.body?.role_id, 'role_id_required');
    const mode = String(req.body?.mode || 'daily_digest_pending_approval').trim();
    if (mode !== 'daily_digest_pending_approval') {
      return sendError(res, 400, {
        error: 'invalid_mode',
        code: 'invalid_mode',
        detail: 'mode must be daily_digest_pending_approval.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const role = await loadRoleForClient(roleId, clientId);
    if (!role) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'role_not_found',
        detail: 'Role not found.',
        request_id
      });
    }

    const payload = {
      client_id: clientId,
      role_id: roleId,
      name: normalizeAutomationRuleName(req.body?.name, { allowOmitted: true }),
      enabled: normalizeEnabled(req.body?.enabled, false),
      mode,
      criteria_config: normalizeCriteriaConfig(normalizeJsonObject(req.body?.criteria_config, 'criteria_config', {})),
      action_config: normalizeJsonObject(req.body?.action_config, 'action_config', {}),
      digest_config: normalizeDigestConfig(normalizeJsonObject(req.body?.digest_config, 'digest_config', {})),
      created_by_user_id: req.user?.id || null,
      created_by_email: cleanUserEmail(req),
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanUserEmail(req)
    };

    const { data, error } = await db
      .from('automation_rules')
      .insert(payload)
      .select(RULE_SELECT)
      .maybeSingle();

    if (error) {
      if (String(error.code || '') === '23505') {
        return sendError(res, 409, {
          error: 'automation_rule_already_exists',
          code: 'automation_rule_already_exists',
          detail: 'This role already has a current automation rule.',
          request_id
        });
      }
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rule_create_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    return res.status(201).json({ ok: true, item: data, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rule_create_failed');
  }
});

router.patch('/rules/:id', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }

    const updates = {
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanUserEmail(req),
      updated_at: new Date().toISOString()
    };
    let hasEditableField = false;
    let configChanged = false;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled')) {
      updates.enabled = normalizeEnabled(req.body.enabled, rule.enabled === true);
      hasEditableField = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      updates.name = normalizeAutomationRuleName(req.body.name);
      hasEditableField = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'criteria_config')) {
      const next = normalizeCriteriaConfig(normalizeJsonObject(req.body.criteria_config, 'criteria_config'));
      updates.criteria_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.criteria_config || {})) configChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'action_config')) {
      const next = normalizeJsonObject(req.body.action_config, 'action_config');
      updates.action_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.action_config || {})) configChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'digest_config')) {
      const next = normalizeDigestConfig(normalizeJsonObject(req.body.digest_config, 'digest_config'));
      updates.digest_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.digest_config || {})) configChanged = true;
    }

    if (!hasEditableField) {
      return sendError(res, 400, {
        error: 'no_update_fields',
        code: 'no_update_fields',
        detail: 'Provide name, enabled, criteria_config, action_config, or digest_config.',
        request_id
      });
    }
    if (configChanged) {
      updates.rule_version = Math.max(1, Number(rule.rule_version || 1)) + 1;
    }

    const { data, error } = await db
      .from('automation_rules')
      .update(updates)
      .eq('id', rule.id)
      .is('archived_at', null)
      .select(RULE_SELECT)
      .maybeSingle();

    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rule_update_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    if (!data) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    return res.json({ ok: true, item: data, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rule_update_failed');
  }
});

router.post('/rules/:id/dry-run', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, rule.client_id, rule.role_id);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      criteriaConfig: rule.criteria_config || {},
      triggerSource: 'dry_run',
      ruleId: rule.id,
      ruleVersion: rule.rule_version,
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      result
    });
    return res.json(evaluationResponse({ result, persisted, rule }));
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_dry_run_failed');
  }
});

router.post('/rules/:id/evaluate-action', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    if (rule.enabled !== true) {
      return sendError(res, 409, {
        error: 'automation_rule_disabled',
        code: 'automation_rule_disabled',
        detail: 'Automation rule must be enabled before creating pending approval actions.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, rule.client_id, rule.role_id);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      criteriaConfig: rule.criteria_config || {},
      triggerSource: 'manual',
      ruleId: rule.id,
      ruleVersion: rule.rule_version,
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      result,
      triggerSource: 'manual'
    });
    const actionOutcome = await createPendingAutomationAction({
      db,
      evaluationRow: persisted?.row || null,
      evaluationResult: result,
      rule,
      actor: actorFromRequest(req),
      requestId: request_id
    });
    const base = evaluationResponse({ result, persisted, rule });
    const actionsCreated = actionOutcome?.action && !actionOutcome?.deduped && !actionOutcome?.skipped ? 1 : 0;
    return res.json({
      ...base,
      action: actionOutcome?.action || null,
      side_effects: {
        actions_created: actionsCreated,
        emails_sent: 0,
        digests_sent: 0
      }
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_evaluate_action_failed');
  }
});

router.post('/dry-run/candidate', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = toRequiredId(req.body?.role_id, 'role_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const criteriaConfig = normalizeCriteriaConfig(normalizeJsonObject(req.body?.criteria_config, 'criteria_config', {}));
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const role = await loadRoleForClient(roleId, clientId);
    if (!role) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'role_not_found',
        detail: 'Role not found.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, clientId, roleId);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId,
      roleId,
      candidateId,
      criteriaConfig,
      triggerSource: 'dry_run',
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule: null,
      clientId,
      roleId,
      candidateId,
      result
    });
    return res.json(evaluationResponse({ result, persisted, rule: null }));
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_dry_run_failed');
  }
});


module.exports = router;

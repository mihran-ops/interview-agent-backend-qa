'use strict';

// The pending-approval digest scheduler: preview, run and send.

const express = require('express');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  ACTION_SELECT,
  DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE,
  RULE_SELECT,
  actorFromRequest,
  annotateConfiguredDigestApprovalBaseSources,
  attachRunnerSeedMetadata,
  automationDigestSchedulerSendEnabled,
  buildConfiguredPendingApprovalDigestGroups,
  buildDigestApprovalUrl,
  buildPendingApprovalDigestPreview,
  buildPreviewActionSummary,
  buildRunnerDigestSeeds,
  buildRunnerDryRunDigests,
  buildRunnerNoActionDigests,
  canConfigureAutomation,
  cleanRouteText,
  configurableClientIds,
  createDigestApprovalTokenForDelivery,
  db,
  deliveryDateForTimezone,
  findActiveDigestDelivery,
  getPendingApprovalDigestConfig,
  handleCaughtError,
  insertDigestDelivery,
  isValidEmail,
  loadRoleForClient,
  localTimeForTimezone,
  mailer,
  markDigestDeliveryFailed,
  markDigestDeliverySent,
  normalizeEmail,
  normalizeLimit,
  normalizeOptionalBoolean,
  prepareConfiguredDigestApprovalBases,
  requestId,
  requireAutomationRunnerAccess,
  resolveDigestApprovalBaseUrl,
  resolvePreviewApprovalBaseUrlOverride,
  revokeDigestApprovalTokenForDelivery,
  sendConfiguredPendingApprovalDigestGroups,
  sendError,
  sortDigestResponseItems,
  toRequiredId,
  validateNowIso,
  writeAutomationActionEvent,
} = require('../../services/automation/index');

const router = express.Router();

router.post('/actions/preview-pending-approval-digests', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = String(req.body?.role_id || '').trim();
    const recipientEmail = req.body?.recipient_email
      ? normalizeEmail(
        req.body.recipient_email,
        'invalid_recipient_email',
        'recipient_email must be a valid email address.'
      )
      : null;
    const limitPerDigest = normalizeLimit(req.body?.limit_per_digest, 25, 100);
    validateNowIso(req.body?.now_iso);
    const approvalBaseOverride = resolvePreviewApprovalBaseUrlOverride(
      req.body?.approval_base_url_override ?? req.body?.approvalBaseUrlOverride
    );

    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to preview automation digests for this client.',
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

    let rulesQuery = db
      .from('automation_rules')
      .select(RULE_SELECT)
      .eq('client_id', clientId)
      .eq('enabled', true)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(500);
    if (roleId) rulesQuery = rulesQuery.eq('role_id', roleId);

    const { data: ruleRows, error: rulesError } = await rulesQuery;
    if (rulesError) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rules_lookup_failed',
        detail: rulesError.message,
        hint: rulesError.hint || null,
        request_id
      });
    }

    const digestRules = (Array.isArray(ruleRows) ? ruleRows : [])
      .filter((rule) => getPendingApprovalDigestConfig(rule));
    if (digestRules.length === 0) {
      return res.json({
        ok: true,
        digests_count: 0,
        digests: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    let actionsQuery = db
      .from('automation_actions')
      .select(ACTION_SELECT)
      .eq('client_id', clientId)
      .eq('state', 'pending_approval')
      .in('rule_id', digestRules.map((rule) => rule.id))
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1000);
    if (roleId) actionsQuery = actionsQuery.eq('role_id', roleId);

    const { data: actionRows, error: actionsError } = await actionsQuery;
    if (actionsError) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_actions_lookup_failed',
        detail: actionsError.message,
        hint: actionsError.hint || null,
        request_id
      });
    }

    const digests = buildPendingApprovalDigestPreview({
      rules: digestRules,
      actions: Array.isArray(actionRows) ? actionRows : [],
      recipientEmail,
      limitPerDigest,
      approvalBaseOverride
    });

    return res.json({
      ok: true,
      digests_count: digests.length,
      digests,
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_pending_approval_digest_preview_failed');
  }
});

router.post('/actions/run-configured-pending-approval-digests', requireAutomationRunnerAccess, async (req, res) => {
  const request_id = requestId(req);
  try {
    const readinessCheck = normalizeOptionalBoolean(req.body?.readiness_check, 'readiness_check', false);
    if (readinessCheck) {
      const { error: readinessError } = await db
        .from('automation_rules')
        .select('id', { head: true })
        .limit(1);
      if (readinessError) {
        return sendError(res, 500, {
          error: 'server_error',
          code: 'automation_digest_runner_config_unreachable',
          detail: readinessError.message,
          hint: readinessError.hint || null,
          request_id
        });
      }
      return res.json({
        ok: true,
        readiness_check: true,
        runner_access: req.isAutomationScheduler === true ? 'scheduler_secret' : 'authenticated',
        config_reachable: true,
        scheduler_send_enabled: automationDigestSchedulerSendEnabled(),
        dry_run: true,
        can_send: false,
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    const clientId = String(req.body?.client_id || '').trim();
    const roleId = String(req.body?.role_id || '').trim();
    const recipientEmail = req.body?.recipient_email
      ? normalizeEmail(
        req.body.recipient_email,
        'invalid_recipient_email',
        'recipient_email must be a valid email address.'
      )
      : null;
    const dryRunRequested = normalizeOptionalBoolean(req.body?.dry_run, 'dry_run', true);
    const sendRequested = normalizeOptionalBoolean(req.body?.send, 'send', false);
    const shouldSend = sendRequested === true && dryRunRequested === false;
    if (req.isAutomationScheduler === true && shouldSend && !automationDigestSchedulerSendEnabled()) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'automation_digest_scheduler_send_disabled',
        detail: 'Scheduled digest sending is disabled.',
        request_id
      });
    }
    const nowIso = validateNowIso(req.body?.now_iso);
    const now = nowIso ? new Date(nowIso) : new Date();
    const limitPerDigest = normalizeLimit(req.body?.limit_per_digest, 25, 100);

    if (clientId && req.isAutomationScheduler !== true && !canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to run automation digests for this client.',
        request_id
      });
    }
    if (roleId && clientId) {
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
    if (shouldSend && (!mailer || typeof mailer.sendPendingApprovalDigestEmail !== 'function')) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_digest_sender_unavailable',
        detail: 'Pending approval digest email could not be sent.',
        request_id
      });
    }

    const accessibleClientIds = !clientId && req.isAutomationScheduler !== true && req.isGlobalAdmin !== true
      ? configurableClientIds(req)
      : null;
    if (Array.isArray(accessibleClientIds) && accessibleClientIds.length === 0) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to run automation digests.',
        request_id
      });
    }

    let rulesQuery = db
      .from('automation_rules')
      .select(RULE_SELECT)
      .eq('enabled', true)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(5000);
    if (clientId) rulesQuery = rulesQuery.eq('client_id', clientId);
    else if (Array.isArray(accessibleClientIds)) rulesQuery = rulesQuery.in('client_id', accessibleClientIds);
    if (roleId) rulesQuery = rulesQuery.eq('role_id', roleId);

    const { data: ruleRows, error: rulesError } = await rulesQuery;
    if (rulesError) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rules_lookup_failed',
        detail: rulesError.message,
        hint: rulesError.hint || null,
        request_id
      });
    }

    const digestRules = (Array.isArray(ruleRows) ? ruleRows : [])
      .filter((rule) => getPendingApprovalDigestConfig(rule));
    if (digestRules.length === 0) {
      return res.json({
        ok: true,
        dry_run: !shouldSend,
        would_send_count: 0,
        digests_count: 0,
        digests: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    const { seeds, dueRuleIds } = buildRunnerDigestSeeds({
      rules: digestRules,
      recipientEmail,
      now
    });
    const dueRules = digestRules.filter((rule) => dueRuleIds.has(rule.id));
    let actionRows = [];
    if (dueRules.length > 0) {
      let actionsQuery = db
        .from('automation_actions')
        .select(ACTION_SELECT)
        .eq('state', 'pending_approval')
        .in('rule_id', dueRules.map((rule) => rule.id))
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(5000);
      if (clientId) actionsQuery = actionsQuery.eq('client_id', clientId);
      else if (Array.isArray(accessibleClientIds)) actionsQuery = actionsQuery.in('client_id', accessibleClientIds);
      if (roleId) actionsQuery = actionsQuery.eq('role_id', roleId);

      const { data, error } = await actionsQuery;
      if (error) {
        return sendError(res, 500, {
          error: 'server_error',
          code: 'automation_pending_approval_actions_lookup_failed',
          detail: error.message,
          hint: error.hint || null,
          request_id
        });
      }
      actionRows = Array.isArray(data) ? data : [];
    }

    const sendGroups = buildConfiguredPendingApprovalDigestGroups({
      rules: dueRules,
      actions: actionRows,
      recipientEmail,
      limitPerDigest
    });
    attachRunnerSeedMetadata(sendGroups, seeds);
    const noActionDigests = buildRunnerNoActionDigests({ seeds, sendGroups });

    if (!shouldSend) {
      annotateConfiguredDigestApprovalBaseSources(sendGroups, null);
      const dryRunOutcome = await buildRunnerDryRunDigests({
        groups: sendGroups,
        roleId: roleId || null
      });
      const digests = sortDigestResponseItems([
        ...dryRunOutcome.digests,
        ...noActionDigests
      ]);
      return res.json({
        ok: true,
        dry_run: true,
        would_send_count: dryRunOutcome.wouldSendCount,
        digests_count: digests.length,
        digests,
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    prepareConfiguredDigestApprovalBases(sendGroups, null);
    const sendOutcome = await sendConfiguredPendingApprovalDigestGroups({
      req,
      clientId: clientId || null,
      roleId: roleId || null,
      groups: sendGroups,
      requestId: request_id
    });
    const digests = sortDigestResponseItems([
      ...sendOutcome.digests,
      ...noActionDigests
    ]);

    return res.json({
      ok: true,
      dry_run: false,
      would_send_count: 0,
      digests_count: digests.length,
      digests,
      side_effects: {
        actions_created: 0,
        emails_sent: sendOutcome.emailsSent,
        digests_sent: sendOutcome.digestsSent
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_configured_pending_approval_digest_runner_failed');
  }
});

router.post('/actions/send-configured-pending-approval-digests', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = String(req.body?.role_id || '').trim();
    const recipientEmail = req.body?.recipient_email
      ? normalizeEmail(
        req.body.recipient_email,
        'invalid_recipient_email',
        'recipient_email must be a valid email address.'
      )
      : null;
    const limitPerDigest = normalizeLimit(req.body?.limit_per_digest, 25, 100);
    const approvalBaseOverride = resolvePreviewApprovalBaseUrlOverride(
      req.body?.approval_base_url_override ?? req.body?.approvalBaseUrlOverride
    );

    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to send configured automation digests for this client.',
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
    if (!mailer || typeof mailer.sendPendingApprovalDigestEmail !== 'function') {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_digest_sender_unavailable',
        detail: 'Pending approval digest email could not be sent.',
        request_id
      });
    }

    let rulesQuery = db
      .from('automation_rules')
      .select(RULE_SELECT)
      .eq('client_id', clientId)
      .eq('enabled', true)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(500);
    if (roleId) rulesQuery = rulesQuery.eq('role_id', roleId);

    const { data: ruleRows, error: rulesError } = await rulesQuery;
    if (rulesError) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rules_lookup_failed',
        detail: rulesError.message,
        hint: rulesError.hint || null,
        request_id
      });
    }

    const digestRules = (Array.isArray(ruleRows) ? ruleRows : [])
      .filter((rule) => getPendingApprovalDigestConfig(rule));
    if (digestRules.length === 0) {
      return res.json({
        ok: true,
        digests_count: 0,
        digests: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    let actionsQuery = db
      .from('automation_actions')
      .select(ACTION_SELECT)
      .eq('client_id', clientId)
      .eq('state', 'pending_approval')
      .in('rule_id', digestRules.map((rule) => rule.id))
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1000);
    if (roleId) actionsQuery = actionsQuery.eq('role_id', roleId);

    const { data: actionRows, error: actionsError } = await actionsQuery;
    if (actionsError) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_actions_lookup_failed',
        detail: actionsError.message,
        hint: actionsError.hint || null,
        request_id
      });
    }

    const groups = buildConfiguredPendingApprovalDigestGroups({
      rules: digestRules,
      actions: Array.isArray(actionRows) ? actionRows : [],
      recipientEmail,
      limitPerDigest
    });
    if (groups.length === 0) {
      return res.json({
        ok: true,
        digests_count: 0,
        digests: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    prepareConfiguredDigestApprovalBases(groups, approvalBaseOverride);

    const outcome = await sendConfiguredPendingApprovalDigestGroups({
      req,
      clientId,
      roleId: roleId || null,
      groups,
      requestId: request_id
    });

    return res.json({
      ok: true,
      digests_count: outcome.digests.length,
      digests: outcome.digests,
      side_effects: {
        actions_created: 0,
        emails_sent: outcome.emailsSent,
        digests_sent: outcome.digestsSent
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_configured_pending_approval_digest_failed');
  }
});

router.post('/actions/send-pending-approval-digest', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = String(req.body?.role_id || '').trim();
    const recipientEmail = String(req.body?.recipient_email || '').trim().toLowerCase();
    const recipientName = cleanRouteText(req.body?.recipient_name, null, 120);
    const limit = normalizeLimit(req.body?.limit, 25, 100);
    if (!isValidEmail(recipientEmail)) {
      return sendError(res, 400, {
        error: 'invalid_recipient_email',
        code: 'invalid_recipient_email',
        detail: 'recipient_email must be a valid email address.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to send automation digests for this client.',
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

    const approvalBase = resolveDigestApprovalBaseUrl(
      req.body?.approval_base_url ?? req.body?.approvalBaseUrl
    );

    let query = db
      .from('automation_actions')
      .select(ACTION_SELECT)
      .eq('client_id', clientId)
      .eq('state', 'pending_approval')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit);
    if (roleId) query = query.eq('role_id', roleId);

    const { data, error } = await query;
    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_actions_lookup_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    const actions = Array.isArray(data) ? data : [];
    if (actions.length === 0) {
      return res.json({
        ok: true,
        items_count: 0,
        items: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    const timezone = DEFAULT_PENDING_APPROVAL_DIGEST_TIMEZONE;
    const sendTimeLocal = localTimeForTimezone(timezone);
    const deliveryDate = deliveryDateForTimezone(timezone);
    const existingDelivery = await findActiveDigestDelivery({
      clientId,
      roleId: roleId || null,
      recipientEmail,
      deliveryDate
    });
    if (existingDelivery) {
      return res.json({
        ok: true,
        items_count: Number(existingDelivery.action_count || 0),
        delivery_status: existingDelivery.status === 'sent' ? 'already_sent' : 'skipped',
        delivery_id: existingDelivery.id,
        items: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    const manualGroup = {
      recipient_email: recipientEmail,
      recipient_name: recipientName,
      timezone,
      send_time_local: sendTimeLocal,
      items: actions.map((action) => ({
        action,
        summary: buildPreviewActionSummary(action)
      }))
    };
    const claim = await insertDigestDelivery({
      req,
      clientId,
      roleId: roleId || null,
      group: manualGroup,
      deliveryDate,
      requestId: request_id
    });
    const delivery = claim.delivery;
    if (!claim.claimed) {
      return res.json({
        ok: true,
        items_count: Number(delivery?.action_count || 0),
        delivery_status: delivery?.status === 'sent' ? 'already_sent' : 'skipped',
        delivery_id: delivery?.id || null,
        items: [],
        side_effects: {
          actions_created: 0,
          emails_sent: 0,
          digests_sent: 0
        },
        request_id
      });
    }

    const actionIds = actions.map((action) => action.id).filter(Boolean);
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

    const digestApprovalUrl = buildDigestApprovalUrl(approvalBase.baseUrl, digestTokenOutcome.token);
    const items = actions.map((action) => ({
      ...buildPreviewActionSummary(action),
      approval_expires_at: digestTokenOutcome.expires_at
    }));

    if (!mailer || typeof mailer.sendPendingApprovalDigestEmail !== 'function') {
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
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_pending_approval_digest_sender_unavailable',
        detail: 'Pending approval digest email could not be sent.',
        request_id
      });
    }

    try {
      const emailResult = await mailer.sendPendingApprovalDigestEmail(recipientEmail, {
        recipientName,
        clientId,
        roleId: roleId || null,
        digestActionCount: items.length,
        digestApprovalUrl,
        digestApprovalExpiresAt: digestTokenOutcome.expires_at,
        actions: items
      });
      if (emailResult?.skipped) {
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
        return sendError(res, 503, {
          error: 'automation_pending_approval_digest_email_not_sent',
          code: 'automation_pending_approval_digest_email_not_sent',
          detail: 'Pending approval digest email could not be sent.',
          request_id
        });
      }
    } catch (_) {
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
      return sendError(res, 502, {
        error: 'automation_pending_approval_digest_send_failed',
        code: 'automation_pending_approval_digest_send_failed',
        detail: 'Pending approval digest email could not be sent.',
        request_id
      });
    }

    const sentDelivery = await markDigestDeliverySent({
      delivery,
      actionIds,
      requestId: request_id
    });
    const recipientDomain = recipientEmail.split('@')[1] || null;
    const actor = actorFromRequest(req);
    for (const action of actions) {
      await writeAutomationActionEvent({
        db,
        actionId: action.id,
        clientId: action.client_id,
        eventType: 'pending_approval_digest_email_sent',
        fromState: 'pending_approval',
        toState: 'pending_approval',
        actor,
        requestId: request_id,
        metadata: {
          email_category: 'automation_pending_approval_digest',
          digest_recipient_email_domain: recipientDomain,
          digest_action_count: items.length,
          approval_url_source: approvalBase.source,
          approval_link_type: 'digest',
          manual_digest: true
        }
      });
    }

    return res.json({
      ok: true,
      items_count: items.length,
      delivery_status: 'sent',
      delivery_id: sentDelivery?.id || delivery?.id || null,
      items,
      side_effects: {
        actions_created: 0,
        emails_sent: 1,
        digests_sent: 1
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_pending_approval_digest_failed');
  }
});


module.exports = router;

'use strict';

// Automation actions and the approval-token flows that resolve them.

const express = require('express');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  ACTION_SELECT,
  actorFromRequest,
  approveSendDigestApprovalAction,
  buildApprovalActionSummary,
  buildAutomationActionPublicSummary,
  buildDigestApprovalActionResultItem,
  buildDigestApprovalReviewItem,
  canConfigureAutomation,
  configurableClientIds,
  confirmActionFromApprovalToken,
  createApprovalTokenForAction,
  db,
  handleCaughtError,
  listAutomationActionEvents,
  listAutomationActions,
  loadAction,
  loadApprovalTokenContext,
  loadCandidateForClient,
  loadDigestApprovalActions,
  loadDigestApprovalContextForItem,
  loadDigestApprovalTokenContext,
  loadRoleForClient,
  mailer,
  markApprovalTokenViewed,
  markDigestApprovalTokenViewed,
  normalizeLimit,
  rejectActionFromApprovalToken,
  rejectDigestApprovalAction,
  requestId,
  resolveClientId,
  sendApprovalTokenUnavailable,
  sendApprovedAutomationActionSchedulingEmail,
  sendDigestApprovalItemUnavailable,
  sendDigestApprovalTokenUnavailable,
  sendError,
  setApprovalNoStore,
  toRequiredId,
  writeAutomationActionEvent,
} = require('../../services/automation/index');

const router = express.Router();

router.get('/actions', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = resolveClientId(req);
    const roleId = String(req.query?.role_id || '').trim();
    const candidateId = String(req.query?.candidate_id || '').trim();
    const state = String(req.query?.state || '').trim();
    const limit = normalizeLimit(req.query?.limit, 100, 500);

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
        detail: 'You do not have access to view automation actions for this client.',
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
    if (candidateId) {
      const candidate = await loadCandidateForClient(candidateId, clientId, roleId || null);
      if (!candidate) {
        return sendError(res, 404, {
          error: 'not_found',
          code: 'candidate_not_found',
          detail: 'Candidate not found.',
          request_id
        });
      }
    }

    const items = await listAutomationActions({
      db,
      clientId,
      roleId: roleId || null,
      candidateId: candidateId || null,
      state: state || null,
      limit
    });
    return res.json({ ok: true, items, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_actions_lookup_failed');
  }
});

router.post('/actions/:id/approval-token', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to create approval tokens for this automation action.',
        request_id
      });
    }
    if (action.state !== 'pending_approval') {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can receive approval tokens.',
        request_id
      });
    }
    if (req.body?.allow_legacy_action_approval_link !== true) {
      return sendError(res, 400, {
        error: 'legacy_action_approval_link_requires_explicit_opt_in',
        code: 'legacy_action_approval_link_requires_explicit_opt_in',
        detail: 'Action-level approval links are legacy. Use digest approval links for client-facing approval workflows.',
        request_id
      });
    }

    const outcome = await createApprovalTokenForAction({
      db,
      action,
      recipientUserId: req.body?.recipient_user_id || req.body?.recipientUserId || null,
      recipientEmail: req.body?.recipient_email || req.body?.recipientEmail || null,
      expiresInHours: req.body?.expires_in_hours ?? req.body?.expiresInHours,
      requestId: request_id
    });

    await writeAutomationActionEvent({
      db,
      actionId: action.id,
      clientId: action.client_id,
      eventType: 'legacy_action_approval_token_created',
      actor: {
        type: 'user',
        userId: req.user?.id || null,
        email: req.user?.email || null
      },
      requestId: request_id,
      metadata: {
        approval_token_id: outcome.tokenRow?.id || null,
        explicit_legacy_opt_in: true,
        approval_link_type: 'legacy_action',
        emails_sent_on_confirm: false
      }
    });

    return res.status(201).json({
      ok: true,
      legacy: true,
      emails_sent_on_confirm: false,
      approval_url_path: `/automation/approval/${outcome.token}`,
      token: outcome.token,
      expires_at: outcome.expires_at,
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_create_failed');
  }
});

router.get('/actions/:id/events', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to view events for this automation action.',
        request_id
      });
    }

    const items = await listAutomationActionEvents({
      db,
      actionId: action.id,
      clientId: action.client_id,
      limit: normalizeLimit(req.query?.limit, 100, 500)
    });
    return res.json({ ok: true, items, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_action_events_lookup_failed');
  }
});

router.post('/actions/:id/send-scheduling-email', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to send this automation action.',
        request_id
      });
    }
    if (action.state !== 'approved') {
      return sendError(res, 409, {
        error: action.state === 'sent' || action.state === 'delivered'
          ? 'automation_action_already_sent'
          : 'invalid_action_state',
        code: action.state === 'sent' || action.state === 'delivered'
          ? 'automation_action_already_sent'
          : 'invalid_action_state',
        detail: action.state === 'sent' || action.state === 'delivered'
          ? 'This automation action has already been sent.'
          : 'Only approved automation actions can send scheduling emails.',
        request_id
      });
    }

    const outcome = await sendApprovedAutomationActionSchedulingEmail({
      db,
      action,
      actor: actorFromRequest(req),
      requestId: request_id,
      mailer
    });

    return res.json({
      ok: true,
      item: outcome?.action ? buildAutomationActionPublicSummary(outcome.action) : null,
      event: outcome?.event || null,
      side_effects: {
        actions_created: 0,
        emails_sent: outcome?.sent ? 1 : 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_action_send_scheduling_email_failed');
  }
});

router.get('/digest-approval/:token', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadDigestApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendDigestApprovalTokenUnavailable(res, req, context);
    }

    const tokenRow = context.tokenRow;
    const actions = await loadDigestApprovalActions(context.delivery);
    const items = actions
      .map((action) => buildDigestApprovalReviewItem({ action, tokenRow }))
      .filter((item) => item.item_id);

    if (items.length === 0) {
      return sendDigestApprovalTokenUnavailable(res, req, { reason: 'no_actions' });
    }

    const viewedToken = await markDigestApprovalTokenViewed({
      db,
      tokenRow,
      requestId: request_id
    });

    return res.json({
      ok: true,
      item: {
        expires_at: viewedToken?.expires_at || tokenRow?.expires_at || null,
        items
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_digest_approval_token_lookup_failed');
  }
});

router.post('/digest-approval/:token/items/:itemId/approve-send', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const { context, action } = await loadDigestApprovalContextForItem({
      token: req.params?.token,
      itemId: req.params?.itemId
    });
    if (!context.valid) {
      return sendDigestApprovalTokenUnavailable(res, req, context);
    }
    if (!action) {
      return sendDigestApprovalItemUnavailable(res, req);
    }

    const outcome = await approveSendDigestApprovalAction({
      action,
      tokenRow: context.tokenRow,
      itemId: req.params?.itemId,
      requestId: request_id
    });

    return res.json({
      ok: true,
      item: buildDigestApprovalActionResultItem({
        action: outcome.action,
        tokenRow: context.tokenRow
      }),
      side_effects: {
        emails_sent: outcome.emailsSent || 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_digest_approval_item_approve_send_failed');
  }
});

router.post('/digest-approval/:token/items/:itemId/reject', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const { context, action } = await loadDigestApprovalContextForItem({
      token: req.params?.token,
      itemId: req.params?.itemId
    });
    if (!context.valid) {
      return sendDigestApprovalTokenUnavailable(res, req, context);
    }
    if (!action) {
      return sendDigestApprovalItemUnavailable(res, req);
    }

    const outcome = await rejectDigestApprovalAction({
      action,
      tokenRow: context.tokenRow,
      itemId: req.params?.itemId,
      requestId: request_id
    });

    return res.json({
      ok: true,
      item: buildDigestApprovalActionResultItem({
        action: outcome.action,
        tokenRow: context.tokenRow
      }),
      side_effects: {
        emails_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_digest_approval_item_reject_failed');
  }
});

router.get('/approval/:token', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendApprovalTokenUnavailable(res, req, context);
    }

    const viewedToken = await markApprovalTokenViewed({
      db,
      tokenRow: context.tokenRow,
      requestId: request_id
    });

    return res.json({
      ok: true,
      item: buildApprovalActionSummary({
        action: context.action,
        tokenRow: viewedToken || context.tokenRow
      }),
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_lookup_failed');
  }
});

router.post('/approval/:token/reject', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendApprovalTokenUnavailable(res, req, context);
    }

    const outcome = await rejectActionFromApprovalToken({
      db,
      tokenRow: context.tokenRow,
      action: context.action,
      actor: { type: 'system' },
      requestId: request_id
    });

    return res.json({
      ok: true,
      state: outcome?.action?.state || 'rejected',
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_reject_failed');
  }
});

router.post('/approval/:token/confirm', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendApprovalTokenUnavailable(res, req, context);
    }

    const outcome = await confirmActionFromApprovalToken({
      db,
      tokenRow: context.tokenRow,
      action: context.action,
      actor: { type: 'system' },
      requestId: request_id
    });

    return res.json({
      ok: true,
      state: outcome?.action?.state || 'approved',
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_confirm_failed');
  }
});

router.post('/actions/:id/reject', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to reject this automation action.',
        request_id
      });
    }
    if (action.state !== 'pending_approval') {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can be rejected.',
        request_id
      });
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
      .eq('state', 'pending_approval')
      .select(ACTION_SELECT)
      .maybeSingle();

    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_action_reject_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    if (!data) {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can be rejected.',
        request_id
      });
    }

    const event = await writeAutomationActionEvent({
      db,
      actionId: data.id,
      clientId: data.client_id,
      eventType: 'action_rejected',
      fromState: 'pending_approval',
      toState: 'rejected',
      actor: actorFromRequest(req),
      requestId: request_id,
      metadata: null
    });

    return res.json({
      ok: true,
      item: data,
      event,
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_action_reject_failed');
  }
});


module.exports = router;

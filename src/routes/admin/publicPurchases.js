'use strict';

// Self-serve purchases: the list, the support playbook and the resend actions. Mounted on the admin router.

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  sendAlphaScreenWelcomeEmail,
  sendMemberRecoveryEmail,
  sendMembershipAgreementEmail,
  sendSubscriptionCheckoutEmail,
} = require('../../../utils/mailer');
const {
  buildAdminPublicPurchasesPayload,
  resendPublicPurchaseAgreementLink,
  resendPublicPurchaseCheckoutLink,
  resendPublicPurchaseSetupEmail,
  resendPublicPurchaseWelcomeEmail,
  safePublicPurchaseActionErrorBody,
  safePublicPurchasesErrorBody,
} = require('../../lib/adminPublicPurchasesService');
const { supabaseAdmin } = require('../../lib/supabaseClient');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { sendAdminError } = require('../../services/admin/adminHelpers');

const router = express.Router();

const PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH = path.join(__dirname, '..', '..', '..', 'templates', 'pdf', 'alphascreen-public-purchase-support-playbook.pdf')

router.get('/public-purchases', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminPublicPurchasesPayload({
      db: supabaseAdmin,
      query: req.query || {},
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicPurchasesErrorBody(error, request_id)
    console.error('[admin/public-purchases] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.get('/public-purchases/playbook.pdf', requireAuth, requireAdmin, async (_req, res) => {
  try {
    if (!fs.existsSync(PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH)) {
      return res.status(404).json({ error: 'playbook_pdf_not_found' })
    }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="alphascreen-public-purchase-support-playbook.pdf"')
    res.setHeader('Cache-Control', 'private, no-store')
    return res.sendFile(PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH)
  } catch (error) {
    console.error('[admin/public-purchases/playbook.pdf] failed', {
      request_id: _req.request_id || null,
      message: error?.message || 'unknown_error'
    })
    return res.status(500).json({ error: 'playbook_pdf_failed' })
  }
})

router.post('/public-purchases/:id/resend-setup-email', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await resendPublicPurchaseSetupEmail({
      db: supabaseAdmin,
      authAdmin: supabaseAdmin.auth?.admin,
      purchaseIntentId: req.params.id,
      actorEmail: req.user?.email || null,
      requestId: request_id,
      sendRecoveryEmail: sendMemberRecoveryEmail,
      logger: console
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicPurchaseActionErrorBody(error, request_id)
    console.error('[admin/public-purchases/resend-setup-email] failed', {
      request_id,
      purchase_intent_id: req.params.id,
      actor: req.user?.email || null,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-purchases/:id/resend-welcome-email', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await resendPublicPurchaseWelcomeEmail({
      db: supabaseAdmin,
      purchaseIntentId: req.params.id,
      actorEmail: req.user?.email || null,
      requestId: request_id,
      sendWelcomeEmail: sendAlphaScreenWelcomeEmail,
      logger: console
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicPurchaseActionErrorBody(error, request_id)
    console.error('[admin/public-purchases/resend-welcome-email] failed', {
      request_id,
      purchase_intent_id: req.params.id,
      actor: req.user?.email || null,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-purchases/:id/resend-agreement-link', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await resendPublicPurchaseAgreementLink({
      db: supabaseAdmin,
      purchaseIntentId: req.params.id,
      actorEmail: req.user?.email || null,
      requestId: request_id,
      sendAgreementEmail: sendMembershipAgreementEmail,
      logger: console
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicPurchaseActionErrorBody(error, request_id)
    console.error('[admin/public-purchases/resend-agreement-link] failed', {
      request_id,
      purchase_intent_id: req.params.id,
      actor: req.user?.email || null,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

router.post('/public-purchases/:id/resend-checkout-link', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await resendPublicPurchaseCheckoutLink({
      db: supabaseAdmin,
      purchaseIntentId: req.params.id,
      actorEmail: req.user?.email || null,
      requestId: request_id,
      sendCheckoutEmail: sendSubscriptionCheckoutEmail,
      logger: console
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicPurchaseActionErrorBody(error, request_id)
    console.error('[admin/public-purchases/resend-checkout-link] failed', {
      request_id,
      purchase_intent_id: req.params.id,
      actor: req.user?.email || null,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})


module.exports = router;

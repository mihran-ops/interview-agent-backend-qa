'use strict';

// Reading back the latest signed agreement for the caller.

const express = require('express');
const { requireAuth, withClientScope } = require('../../../middleware/auth');
const {
  SIGNED_URL_TTL_SECONDS,
  createAgreementSignedUrl,
  resolveLegalBillingAgreementClient,
  supabaseAdmin,
} = require('../../../services/membershipAgreements/index');

const router = express.Router();

router.get('/latest-signed', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const access = await resolveLegalBillingAgreementClient(req, clientId, request_id);
    if (!access.ok) return res.status(access.status || 403).json(access.body);
    const agreementClientId = access.client_id;

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,client_id,status,signed_at,signer_typed_name,client_legal_name,executed_pdf_path,created_at,is_current')
      .eq('client_id', agreementClientId)
      .eq('status', 'signed')
      .eq('is_current', true)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed] query_failed', {
        request_id,
        client_id: agreementClientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement: {
        id: latest.id,
        client_id: latest.client_id,
        status: latest.status,
        signed_at: latest.signed_at,
        signer_typed_name: latest.signer_typed_name,
        client_legal_name: latest.client_legal_name,
        executed_pdf_url: executedPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

router.get('/latest-signed-url', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const access = await resolveLegalBillingAgreementClient(req, clientId, request_id);
    if (!access.ok) return res.status(access.status || 403).json(access.body);
    const agreementClientId = access.client_id;

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,executed_pdf_path,created_at,signed_at,is_current')
      .eq('client_id', agreementClientId)
      .eq('status', 'signed')
      .eq('is_current', true)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed-url] query_failed', {
        request_id,
        client_id: agreementClientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement_id: latest.id,
      executed_pdf_url: executedPdfUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed-url] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});


module.exports = router;

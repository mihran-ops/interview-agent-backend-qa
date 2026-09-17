'use strict';


// Membership agreement signing and token handling: thirty-two helpers that sat
// above five endpoints in routes/membershipAgreementsPublic.js. Moved verbatim.

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireParentClient, resolveBillingOwnerForScope } = require('../clientBillingScope');
const { canViewLegalBillingForClient } = require('../clientScope');
const { buildMembershipAgreementSignUrl } = require('../../config/urlConfig');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { htmlToPdf } = require('../../render/pdfRenderer');
const {
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
} = require('../../render/membershipAgreement');
const {
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification
} = require('../../clients/sendgrid');
const { createSubscriptionCheckoutSession } = require('../subscriptionCheckout');
const {
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval,
  getAlphaScreenPlatformFee,
  getAlphaScreenFirstRolePrepayConfig
} = require('../alphaScreenPackages');


const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements';
const MEMBERSHIP_INTERNAL_NOTIFY_EMAIL = 'memberships@alphasourceai.com';
const SIGNED_URL_TTL_SECONDS = Math.max(60, Number(process.env.SIGNED_URL_TTL_SECONDS || 600));
const EMAIL_SIGNED_URL_TTL_SECONDS = Math.max(300, Number(process.env.AGREEMENT_SIGNED_EMAIL_LINK_TTL_SECONDS || 604800));
const PUBLIC_TOKEN_RATE_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_TOKEN_RATE_MAX = Number(process.env.MEMBERSHIP_AGREEMENT_PUBLIC_TOKEN_RATE_MAX || 60);
const publicAgreementTokenRateBuckets = new Map();

// req.ip only. Reading X-Forwarded-For directly bypassed the app's trust proxy setting,
// so any caller could mint a fresh rate-limit bucket per request by varying the header.
function getRequestIp(req) {
  return String(req.ip || 'unknown').trim() || 'unknown';
}

function publicAgreementTokenRateLimit(req, res, next) {
  const now = Date.now();
  const routeKey = `${req.method || 'POST'}:${req.path || req.originalUrl || 'membership-agreement'}`;
  const subject = `${getRequestIp(req)}:${routeKey}`;
  const current = publicAgreementTokenRateBuckets.get(subject);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + PUBLIC_TOKEN_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  publicAgreementTokenRateBuckets.set(subject, bucket);
  if (bucket.count > PUBLIC_TOKEN_RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.',
      request_id: req.request_id || null
    });
  }
  return next();
}

function extractErrorMessage(text, fallback) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed?.detail || parsed?.message || parsed?.error;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch (_) {}
  return raw;
}

function makeCheckoutError(status, code, detail, hint) {
  const err = new Error(detail || code || 'checkout_failed');
  err.status = Number(status) || 500;
  err.code = String(code || 'checkout_failed');
  err.hint = hint || null;
  return err;
}

function readToken(req) {
  return String(req.body?.token || '').trim();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'client';
}

function normalizeAccepted(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function wantsEmbeddedCheckout(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'embedded';
}

function appendQueryParam(url, key, value) {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  const separator = raw.includes('?') ? '&' : '?';
  return `${raw}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0] || '').trim();
    if (first) return first;
  }

  return String(req.ip || '').trim() || null;
}

function parseSignaturePayload(raw) {
  const source = String(raw || '').trim();
  if (!source) {
    const err = new Error('signature_required');
    err.code = 'signature_required';
    throw err;
  }

  const match = source.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }

  const mimeRaw = String(match[1] || '').toLowerCase();
  const mime = mimeRaw === 'image/jpg' ? 'image/jpeg' : mimeRaw;
  const base64 = String(match[2] || '').replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }
  if (buffer.length > 2 * 1024 * 1024) {
    const err = new Error('signature_too_large');
    err.code = 'signature_too_large';
    throw err;
  }

  const ext = mime === 'image/png'
    ? 'png'
    : mime === 'image/webp'
      ? 'webp'
      : 'jpg';

  return {
    mime,
    ext,
    base64,
    buffer,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

function isExpired(isoTime) {
  if (!isoTime) return false;
  const ts = Date.parse(String(isoTime));
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now();
}

function validateSignableAgreement(row) {
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'token_invalid',
      detail: 'This signing link is invalid.'
    };
  }

  if (String(row.status || '').toLowerCase() !== 'sent') {
    return {
      ok: false,
      status: 409,
      code: 'agreement_not_signable',
      detail: 'This agreement is no longer available for signing.'
    };
  }

  if (isExpired(row.signer_token_expires_at)) {
    return {
      ok: false,
      status: 410,
      code: 'token_expired',
      detail: 'This signing link has expired.'
    };
  }

  return { ok: true };
}

async function requireParentAgreementClient(agreement, context) {
  return requireParentClient(supabaseAdmin, agreement?.client_id, context);
}

function isPublicPurchaseIntentAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  return String(snapshot?.source || '').trim() === 'public_purchase_intent';
}

function publicPurchaseIntentIdFromAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  return String(snapshot?.purchase_intent?.id || '').trim();
}

function packageSnapshotFromAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  const packageSnapshot = snapshot?.package_snapshot && typeof snapshot.package_snapshot === 'object'
    ? snapshot.package_snapshot
    : null;
  return packageSnapshot || null;
}

function packageNumber(snapshot, ...keys) {
  for (const key of keys) {
    const n = Number(snapshot?.[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function firstRolePrepaySnapshot(packageSnapshot) {
  return packageSnapshot?.first_role_prepay && typeof packageSnapshot.first_role_prepay === 'object'
    ? packageSnapshot.first_role_prepay
    : null;
}

function buildFirstRolePrepayCheckout(packageSnapshot) {
  const prepay = firstRolePrepaySnapshot(packageSnapshot);
  if (!prepay?.selected) return null;
  return {
    selected: true,
    credit_type: prepay.credit_type || 'first_role_prepay',
    amount_cents: Number(prepay.discounted_credit_amount_cents),
    normal_role_fee_cents: Number(prepay.normal_role_fee_cents),
    discount_percent: Number(prepay.discount_percent)
  };
}

function buildPublicAgreementCheckoutMetadata({ agreement, agreementInput, intent, packageSnapshot }) {
  const planTier = normalizeAlphaScreenPlanKey(packageSnapshot?.plan_key || agreementInput?.membership_tier);
  const billingInterval = normalizeBillingInterval(packageSnapshot?.billing_cadence || agreementInput?.billing_option);
  const firstRolePrepay = buildFirstRolePrepayCheckout(packageSnapshot);
  const metadata = {
    agreement_id: agreement.id,
    purchase_intent_id: intent?.id || undefined,
    public_purchase_intent_id: intent?.id || undefined,
    membership_agreement_id: agreement.id,
    agreement_checkout: 'true',
    checkout_status: 'pending_payment',
    package_plan_key: planTier,
    package_billing_cadence: billingInterval,
    platform_fee: packageNumber(packageSnapshot, 'platform_fee'),
    per_role_fee: packageNumber(packageSnapshot, 'per_role_fee'),
    included_interviews_per_role: packageNumber(packageSnapshot, 'included_interviews_per_role', 'included_interviews'),
    additional_interview_fee: packageNumber(packageSnapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price'),
    max_interview_minutes: packageNumber(packageSnapshot, 'max_interview_minutes', 'interview_duration_minutes')
  };
  if (firstRolePrepay?.selected) {
    metadata.first_role_prepay_selected = 'true';
    metadata.first_role_prepay_credit_type = firstRolePrepay.credit_type;
    metadata.first_role_prepay_amount_cents = firstRolePrepay.amount_cents;
    metadata.first_role_prepay_normal_role_fee_cents = firstRolePrepay.normal_role_fee_cents;
    metadata.first_role_prepay_discount_percent = firstRolePrepay.discount_percent;
  }
  return metadata;
}

function validatePublicPurchaseIntentForCheckout({ agreement, agreementInput, intent }) {
  if (!intent) {
    throw makeCheckoutError(404, 'purchase_intent_not_found', 'Signup request was not found.');
  }

  const status = String(intent.status || '').trim().toLowerCase();
  if (!['agreement_pending', 'checkout_pending'].includes(status)) {
    throw makeCheckoutError(409, 'purchase_intent_not_checkout_eligible', 'Signup request is not eligible for checkout.');
  }

  const agreementId = String(agreement?.id || '').trim();
  const intentAgreementId = String(intent.agreement_id || '').trim();
  if (!intentAgreementId || intentAgreementId !== agreementId) {
    throw makeCheckoutError(409, 'purchase_intent_agreement_mismatch', 'Signup request is not linked to this agreement.');
  }

  const packageSnapshot = packageSnapshotFromAgreement(agreement);
  if (!packageSnapshot) {
    throw makeCheckoutError(409, 'package_snapshot_missing', 'Agreement package snapshot is missing.');
  }

  const planTier = normalizeAlphaScreenPlanKey(agreementInput?.membership_tier);
  const billingInterval = normalizeBillingInterval(agreementInput?.billing_option);
  const snapshotPlan = normalizeAlphaScreenPlanKey(packageSnapshot.plan_key);
  const snapshotBilling = normalizeBillingInterval(packageSnapshot.billing_cadence);
  const intentPlan = normalizeAlphaScreenPlanKey(intent.selected_plan_key);
  const intentBilling = normalizeBillingInterval(intent.selected_billing_cadence);

  if (!['basic', 'pro'].includes(planTier) || !['basic', 'pro'].includes(snapshotPlan) || !['basic', 'pro'].includes(intentPlan)) {
    throw makeCheckoutError(409, 'invalid_agreement_plan', 'Agreement plan tier is invalid for checkout.');
  }
  if (!billingInterval || !snapshotBilling || !intentBilling) {
    throw makeCheckoutError(409, 'invalid_agreement_billing_interval', 'Agreement billing interval is invalid for checkout.');
  }
  if (planTier !== snapshotPlan || planTier !== intentPlan || billingInterval !== snapshotBilling || billingInterval !== intentBilling) {
    throw makeCheckoutError(409, 'package_snapshot_mismatch', 'Agreement package selection does not match the signup request.');
  }

  const configuredPlatformFee = getAlphaScreenPlatformFee(planTier, billingInterval);
  const snapshotPlatformFee = packageNumber(packageSnapshot, 'platform_fee');
  const perRoleFee = packageNumber(packageSnapshot, 'per_role_fee');
  const includedInterviews = packageNumber(packageSnapshot, 'included_interviews_per_role', 'included_interviews');
  const additionalInterviewFee = packageNumber(packageSnapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price');
  const maxInterviewMinutes = packageNumber(packageSnapshot, 'max_interview_minutes', 'interview_duration_minutes');
  const firstRolePrepay = firstRolePrepaySnapshot(packageSnapshot);
  const firstRolePrepaySelected = firstRolePrepay?.selected === true;
  const expectedPrepay = getAlphaScreenFirstRolePrepayConfig(planTier);
  if (
    configuredPlatformFee === null ||
    snapshotPlatformFee === null ||
    Number(snapshotPlatformFee) !== Number(configuredPlatformFee) ||
    perRoleFee === null ||
    includedInterviews === null ||
    additionalInterviewFee === null ||
    maxInterviewMinutes === null
  ) {
    throw makeCheckoutError(409, 'package_snapshot_invalid', 'Agreement package snapshot is invalid for checkout.');
  }
  if (intent.first_role_prepay_selected === true && !firstRolePrepaySelected) {
    throw makeCheckoutError(409, 'first_role_prepay_snapshot_missing', 'Agreement first-role prepay snapshot is missing.');
  }
  if (firstRolePrepaySelected) {
    if (
      !expectedPrepay ||
      firstRolePrepay.credit_type !== expectedPrepay.credit_type ||
      Number(firstRolePrepay.normal_role_fee_cents) !== Number(expectedPrepay.normal_role_fee_cents) ||
      Number(firstRolePrepay.discounted_credit_amount_cents) !== Number(expectedPrepay.discounted_credit_amount_cents) ||
      Number(firstRolePrepay.discount_percent) !== Number(expectedPrepay.discount_percent)
    ) {
      throw makeCheckoutError(409, 'first_role_prepay_snapshot_invalid', 'Agreement first-role prepay snapshot is invalid for checkout.');
    }
  }

  return {
    planTier,
    billingInterval,
    packageSnapshot
  };
}

async function loadPublicPurchaseIntentForAgreement(agreement) {
  const purchaseIntentId = publicPurchaseIntentIdFromAgreement(agreement);
  if (!purchaseIntentId) {
    throw makeCheckoutError(409, 'purchase_intent_missing', 'Agreement is missing its signup request reference.');
  }

  const { data, error } = await supabaseAdmin
    .from('public_purchase_intents')
    .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,expires_at,created_at')
    .eq('id', purchaseIntentId)
    .maybeSingle();
  if (error) {
    throw makeCheckoutError(503, error.code || 'purchase_intent_lookup_failed', error.message || 'Signup request lookup failed.', error.hint || null);
  }
  return data || null;
}

async function ensurePublicAgreementCheckoutClient({ agreement, agreementInput, intent, planTier, billingInterval }) {
  const nowIso = new Date().toISOString();
  let clientId = String(agreement.client_id || intent?.client_id || '').trim();

  if (!clientId) {
    const firstName = String(intent?.buyer_first_name || '').trim();
    const lastName = String(intent?.buyer_last_name || '').trim();
    const adminName = `${firstName} ${lastName}`.trim() || String(intent?.buyer_email || '').trim();
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .insert({
        name: String(intent?.company_legal_name || agreementInput.client_legal_name || '').trim(),
        email: String(intent?.buyer_email || agreementInput.admin_email || '').trim().toLowerCase(),
        client_admin_name: adminName || null,
        plan_tier: planTier,
        billing_interval: billingInterval,
        billing_status: 'inactive',
        subscription_status: 'incomplete',
        auto_renew: false
      })
      .select('id,name,email,client_admin_name')
      .single();
    if (clientErr || !client?.id) {
      throw makeCheckoutError(503, clientErr?.code || 'checkout_client_create_failed', clientErr?.message || 'Could not prepare billing account.', clientErr?.hint || null);
    }
    clientId = String(client.id || '').trim();
  }

  if (!clientId) {
    throw makeCheckoutError(500, 'checkout_client_missing', 'Could not prepare billing account.');
  }

  if (String(agreement.client_id || '').trim() !== clientId) {
    const { error: agreementUpdateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', agreement.id)
      .eq('status', 'signed')
      .eq('is_current', true);
    if (agreementUpdateErr) {
      throw makeCheckoutError(503, agreementUpdateErr.code || 'agreement_client_link_failed', agreementUpdateErr.message || 'Could not link agreement to billing account.', agreementUpdateErr.hint || null);
    }
    agreement.client_id = clientId;
  }

  if (String(intent?.client_id || '').trim() !== clientId) {
    const { error: intentClientErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', intent.id);
    if (intentClientErr) {
      throw makeCheckoutError(503, intentClientErr.code || 'purchase_intent_client_link_failed', intentClientErr.message || 'Could not link signup request to billing account.', intentClientErr.hint || null);
    }
    intent.client_id = clientId;
  }

  return clientId;
}

async function requireAgreementClientWhenPresent(agreement, context) {
  if (!String(agreement?.client_id || '').trim() && isPublicPurchaseIntentAgreement(agreement)) {
    return { ok: true, client: null, clientId: null };
  }
  return requireParentAgreementClient(agreement, context);
}

function respondWithAgreementClientGuard(res, result, request_id) {
  return res.status(result.status || 500).json({
    ...(result.body || {
      error: 'client_lookup_failed',
      code: 'client_lookup_failed',
      detail: 'Client lookup failed.'
    }),
    request_id
  });
}

function resolveAgreementPublicSessionState(row) {
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'token_invalid',
      detail: 'This signing link is invalid.'
    };
  }

  const status = String(row.status || '').trim().toLowerCase();
  const checkoutStatus = String(row.checkout_status || '').trim().toLowerCase();

  if (status === 'sent') {
    if (isExpired(row.signer_token_expires_at)) {
      return {
        ok: false,
        status: 410,
        code: 'token_expired',
        detail: 'This signing link has expired.'
      };
    }
    return {
      ok: true,
      state: 'signable'
    };
  }

  if (status === 'signed' && row.is_current === true) {
    if (!String(row.client_id || '').trim() && isPublicPurchaseIntentAgreement(row)) {
      return {
        ok: true,
        state: 'agreement_signed_pending_payment_setup'
      };
    }
    if (checkoutStatus === 'paid') {
      return {
        ok: true,
        state: 'activation_complete'
      };
    }
    if (!checkoutStatus || checkoutStatus === 'pending_payment') {
      return {
        ok: true,
        state: 'activation_pending'
      };
    }
  }

  return {
    ok: false,
    status: 409,
    code: 'agreement_not_available',
    detail: 'This agreement is no longer available.'
  };
}

function buildAgreementInputFromRow(row) {
  const snapshotValues =
    row?.template_snapshot &&
    typeof row.template_snapshot === 'object' &&
    row.template_snapshot.values &&
    typeof row.template_snapshot.values === 'object'
      ? row.template_snapshot.values
      : null;

  if (snapshotValues) {
    return normalizeMembershipAgreementInput(snapshotValues);
  }

  return normalizeMembershipAgreementInput({
    client_id: row?.client_id || null,
    client_legal_name: row?.client_legal_name || '',
    dba_trade_name: row?.dba_trade_name || '',
    primary_admin_name: row?.primary_admin_name || '',
    admin_email: row?.admin_email || '',
    membership_tier: row?.membership_tier || '',
    initial_term_start: row?.initial_term_start || '',
    initial_renewal_date: row?.initial_renewal_date || '',
    billing_option: row?.billing_option || '',
    auto_renew: row?.auto_renew,
    notice_deadline_days: row?.notice_deadline_days
  });
}

async function createAgreementSignedUrl(path, expiresInSeconds) {
  const key = String(path || '').trim();
  if (!key) return null;
  const { data, error } = await supabaseAdmin
    .storage
    .from(AGREEMENTS_BUCKET)
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadAgreementByTokenHash(tokenHash) {
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,status,is_current,checkout_status,checkout_session_id,checkout_created_at,client_legal_name,dba_trade_name,primary_admin_name,admin_email,membership_tier,initial_term_start,initial_renewal_date,billing_option,auto_renew,notice_deadline_days,template_snapshot,draft_pdf_path,executed_pdf_path,signer_token_expires_at,opened_at,sent_at,signed_at,signer_typed_name')
    .eq('signer_token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message || 'agreement_lookup_failed');
    err.code = error.code || 'agreement_lookup_failed';
    err.hint = error.hint || null;
    throw err;
  }

  return data || null;
}

async function resolveLegalBillingAgreementClient(req, clientId, requestId) {
  const requestedClientId = String(clientId || '').trim();
  if (!requestedClientId || requestedClientId === 'all') {
    return { ok: true, client_id: null };
  }

  const scopedIds = Array.isArray(req.client_memberships)
    ? req.client_memberships
    : (Array.isArray(req.clientIds) ? req.clientIds : []);
  const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
  if (!isGlobalAdmin && !scopedIds.includes(requestedClientId)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Client scope mismatch.',
        request_id: requestId
      }
    };
  }

  const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, requestedClientId);
  if (!billingScope.ok) {
    return {
      ok: false,
      status: billingScope.status || 500,
      body: {
        error: billingScope.body?.error || billingScope.body?.code || 'billing_client_lookup_failed',
        code: billingScope.body?.code || billingScope.body?.error || 'billing_client_lookup_failed',
        detail: billingScope.body?.detail || 'Billing client lookup failed.',
        hint: billingScope.body?.hint || null,
        request_id: requestId
      }
    };
  }

  if (
    !isGlobalAdmin &&
    !canViewLegalBillingForClient(req.clientScope, billingScope.scopeClientId || requestedClientId) &&
    !canViewLegalBillingForClient(req.clientScope, billingScope.billingClientId)
  ) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Legal billing access is required.',
        request_id: requestId
      }
    };
  }

  return {
    ok: true,
    client_id: billingScope.billingClientId || requestedClientId,
    scope_client_id: billingScope.scopeClientId || requestedClientId
  };
}

module.exports = {
  AGREEMENTS_BUCKET,
  EMAIL_SIGNED_URL_TTL_SECONDS,
  MEMBERSHIP_INTERNAL_NOTIFY_EMAIL,
  SIGNED_URL_TTL_SECONDS,
  appendQueryParam,
  buildAgreementInputFromRow,
  buildFirstRolePrepayCheckout,
  buildMembershipAgreementHtml,
  buildMembershipAgreementSignUrl,
  buildPublicAgreementCheckoutMetadata,
  createAgreementSignedUrl,
  createSubscriptionCheckoutSession,
  crypto,
  ensurePublicAgreementCheckoutClient,
  extractErrorMessage,
  getClientIp,
  hashToken,
  htmlToPdf,
  isPublicPurchaseIntentAgreement,
  loadAgreementByTokenHash,
  loadPublicPurchaseIntentForAgreement,
  normalizeAccepted,
  parseSignaturePayload,
  publicAgreementTokenRateLimit,
  readToken,
  requireAgreementClientWhenPresent,
  requireParentAgreementClient,
  resolveAgreementPublicSessionState,
  resolveLegalBillingAgreementClient,
  respondWithAgreementClientGuard,
  sendMembershipAgreementCompletedInternalNotification,
  sendMembershipAgreementSignedCopyEmail,
  slugify,
  supabaseAdmin,
  validatePublicPurchaseIntentForCheckout,
  validateSignableAgreement,
  wantsEmbeddedCheckout,
};

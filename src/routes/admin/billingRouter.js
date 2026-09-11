'use strict';

const express = require('express');
const crypto = require('crypto');
let stripe = null;
try {
  stripe = require('../../clients/stripe');
} catch (e) {
  console.error('[billing] stripe_client_load_failed', e?.message || e);
}
const { supabaseAnon, supabaseAdmin } = require('../../clients/supabase');
const { requireParentClient } = require('../../services/clientBillingScope');
const { htmlToPdf } = require('../../render/pdfRenderer');
const { buildMembershipAgreementHtml, normalizeMembershipAgreementInput } = require('../../render/membershipAgreement');
const { sendMembershipAgreementEmail, sendMembershipAgreementInternalNotification } = require('../../clients/sendgrid');
const { buildMembershipAgreementSignUrl } = require('../../config/urlConfig');

const router = express.Router();
const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements';
const MEMBERSHIP_INTERNAL_NOTIFY_EMAIL = 'memberships@alphasourceai.com';
const SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGREEMENT_CLIENT_MODE_ATTACH = 'attach_existing_client';
const AGREEMENT_CLIENT_MODE_ADD = 'add_new_client';
const BILLING_INVOICE_SELECT = 'id,billing_customer_id,title,invoice_title,invoice_description,amount_total_cents,currency,status,hosted_invoice_url,stripe_invoice_id,created_at,customer_name,customer_email';
const AGREEMENT_PENDING_SELECT = 'id,client_id,status,checkout_status,client_legal_name,admin_email,sent_at,opened_at,signed_at,checkout_created_at,checkout_session_id,is_current,voided_at,voided_by_email,void_reason,created_at';

const bearer = (req) => {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

async function requireAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: data.user.id, email: data.user.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const email = req.user?.email || null;
    if (!email) return res.status(403).json({ error: 'not_admin' });
    const { data: adm, error } = await supabaseAdmin
      .from('admins')
      .select('id,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.error('[billing] admin_lookup_failed', { request_id: req.request_id || null, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'admin_lookup_failed', code: error.code || 'admin_lookup_failed', detail: error.message, hint: error.hint, request_id: req.request_id || null });
    }
    if (!adm) return res.status(403).json({ error: 'not_admin' });
    next();
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed', code: 'admin_guard_failed', detail: e?.message || e });
  }
}

router.use(requireAuth, requireAdmin);

function normalizeAgreementClientMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === AGREEMENT_CLIENT_MODE_ADD) return AGREEMENT_CLIENT_MODE_ADD;
  return AGREEMENT_CLIENT_MODE_ATTACH;
}

function normalizeAgreementPayload(raw) {
  const body = raw || {};
  const normalized = normalizeMembershipAgreementInput(body);
  const normalizedClientId = UUID_RE.test(normalized.client_id || '') ? normalized.client_id : null;
  const attachedClientIdRaw = String(
    body.attached_client_id ||
    body.attachedClientId ||
    normalizedClientId ||
    ''
  ).trim();
  const attachedClientId = UUID_RE.test(attachedClientIdRaw) ? attachedClientIdRaw : normalizedClientId;

  return {
    ...normalized,
    client_id: attachedClientId,
    attached_client_id: attachedClientId,
    client_mode: normalizeAgreementClientMode(body.client_mode || body.clientMode),
    candidate_assistance_contact: String(body.candidate_assistance_contact || body.candidateAssistanceContact || '').trim(),
    confirm_replace_existing: body.confirm_replace_existing === true || body.confirmReplaceExisting === true
  };
}

function validateAgreementPayload(payload) {
  const missing = [];
  if (!payload.client_legal_name) missing.push('client_legal_name');
  if (!payload.primary_admin_name) missing.push('primary_admin_name');
  if (!payload.admin_email) missing.push('admin_email');
  if (!payload.initial_term_start) missing.push('initial_term_start');
  if (!payload.initial_renewal_date) missing.push('initial_renewal_date');

  if (missing.length) {
    return {
      ok: false,
      code: 'missing_fields',
      detail: `Missing required fields: ${missing.join(', ')}`
    };
  }

  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.admin_email);
  if (!emailLooksValid) {
    return {
      ok: false,
      code: 'invalid_email',
      detail: 'Admin email must be a valid email address.'
    };
  }

  if (payload.client_mode === AGREEMENT_CLIENT_MODE_ATTACH && !payload.attached_client_id) {
    return {
      ok: false,
      code: 'client_id_required',
      detail: 'Select an existing client to attach this agreement.'
    };
  }

  if (payload.client_mode === AGREEMENT_CLIENT_MODE_ADD && !payload.candidate_assistance_contact) {
    return {
      ok: false,
      code: 'candidate_assistance_contact_required',
      detail: 'Candidate Assistance Contact is required when adding a new client.'
    };
  }

  return { ok: true };
}

async function requireParentClientForAdminBilling(clientId, context) {
  return requireParentClient(supabaseAdmin, clientId, context);
}

function respondWithParentClientGuard(res, result, request_id) {
  return res.status(result.status || 500).json({
    ...(result.body || {
      error: 'client_lookup_failed',
      code: 'client_lookup_failed',
      detail: 'Client lookup failed.'
    }),
    request_id
  });
}

async function resolveAgreementAdminUserId(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const findUserId = async () => {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email: normalizedEmail });
    if (error) {
      const err = new Error(error.message || 'auth_user_lookup_failed');
      err.code = error.code || 'auth_user_lookup_failed';
      throw err;
    }
    const existing = (data?.users || []).find((user) => String(user?.email || '').trim().toLowerCase() === normalizedEmail);
    return existing?.id || null;
  };

  let userId = await findUserId();
  if (userId) return userId;

  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: normalizedEmail,
      email_confirm: true
    });
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('exists')) {
        userId = await findUserId();
      } else {
        const err = new Error(error.message || 'auth_user_create_failed');
        err.code = error.code || 'auth_user_create_failed';
        throw err;
      }
    } else {
      userId = data?.user?.id || null;
    }
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    if (!msg.includes('already') && !msg.includes('exists')) {
      const err = new Error(e?.message || 'auth_user_create_failed');
      err.code = e?.code || 'auth_user_create_failed';
      throw err;
    }
    userId = await findUserId();
  }

  if (!userId) {
    const err = new Error('Could not create or locate admin user for this client.');
    err.code = 'auth_user_missing';
    throw err;
  }

  return userId;
}

async function ensureAgreementClientManagerMembership(clientId, payload) {
  const normalizedClientId = String(clientId || '').trim();
  const email = String(payload?.admin_email || '').trim().toLowerCase();
  const name = String(payload?.primary_admin_name || '').trim();
  if (!normalizedClientId || !email) return null;

  const userId = await resolveAgreementAdminUserId(email);
  let memberSelect = 'id,client_id,user_id,email,name,role,created_at';
  let { data: existingRows, error: lookupErr } = await supabaseAdmin
    .from('client_members')
    .select('id,client_id,user_id,email,name,role,created_at')
    .eq('client_id', normalizedClientId);

  if (lookupErr && (lookupErr.code === '42703' || lookupErr.code === 'PGRST204')) {
    memberSelect = 'client_id,user_id,email,name,role,created_at';
    ({ data: existingRows, error: lookupErr } = await supabaseAdmin
      .from('client_members')
      .select(memberSelect)
      .eq('client_id', normalizedClientId));
  }

  if (lookupErr) {
    const err = new Error(lookupErr.message || 'membership_lookup_failed');
    err.code = lookupErr.code || 'membership_lookup_failed';
    throw err;
  }

  const existingMembership = (existingRows || []).find((row) => {
    const rowEmail = String(row?.email || '').trim().toLowerCase();
    const rowUserId = String(row?.user_id || '').trim();
    return (rowEmail && rowEmail === email) || (rowUserId && rowUserId === userId);
  }) || null;

  if (!existingMembership) {
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .insert({ client_id: normalizedClientId, email, name: name || email, role: 'manager', user_id: userId })
      .select(memberSelect)
      .single();
    if (error) {
      const err = new Error(error.message || 'membership_insert_failed');
      err.code = error.code || 'membership_insert_failed';
      err.hint = error.hint || null;
      throw err;
    }
    return data;
  }

  const updatePayload = {};
  if (String(existingMembership.role || '').trim().toLowerCase() !== 'manager') updatePayload.role = 'manager';
  if (String(existingMembership.email || '').trim().toLowerCase() !== email) updatePayload.email = email;
  if (!String(existingMembership.name || '').trim() && name) updatePayload.name = name;
  if (!String(existingMembership.user_id || '').trim()) updatePayload.user_id = userId;
  if (!Object.keys(updatePayload).length) return existingMembership;

  let updateQuery = supabaseAdmin
    .from('client_members')
    .update(updatePayload)
    .eq('client_id', normalizedClientId);

  const existingId = String(existingMembership.id || '').trim();
  const existingEmail = String(existingMembership.email || '').trim();
  const existingUserId = String(existingMembership.user_id || '').trim();
  if (existingId) {
    updateQuery = updateQuery.eq('id', existingId);
  } else {
    updateQuery = existingEmail ? updateQuery.eq('email', existingEmail) : updateQuery.eq('user_id', existingUserId);
  }

  const { data, error } = await updateQuery
    .select(memberSelect)
    .single();
  if (error) {
    const err = new Error(error.message || 'membership_update_failed');
    err.code = error.code || 'membership_update_failed';
    err.hint = error.hint || null;
    throw err;
  }
  return data;
}

async function createClientFromAgreementPayload(payload) {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .insert({
      name: payload.client_legal_name,
      email: payload.admin_email,
      client_admin_name: payload.primary_admin_name || null,
      candidate_assistance_contact: payload.candidate_assistance_contact,
      plan_tier: null,
      billing_interval: null
    })
    .select('id,name,email,candidate_assistance_contact')
    .single();

  if (error) {
    const err = new Error(error.message || 'create_client_failed');
    err.code = error.code || 'create_client_failed';
    err.hint = error.hint || null;
    throw err;
  }

  await ensureAgreementClientManagerMembership(data.id, payload);

  return data;
}

async function resolveAgreementClientContext(payload) {
  if (payload.client_mode === AGREEMENT_CLIENT_MODE_ADD) {
    const createdClient = await createClientFromAgreementPayload(payload);
    return {
      client_id: createdClient?.id || null,
      created_client: createdClient || null
    };
  }

  const clientId = String(payload.attached_client_id || payload.client_id || '').trim();
  if (!clientId) {
    const err = new Error('Select an existing client to attach this agreement.');
    err.code = 'client_id_required';
    err.status = 400;
    throw err;
  }

  const { data: existingClient, error: existingClientErr } = await supabaseAdmin
    .from('clients')
    .select('id,name,email')
    .eq('id', clientId)
    .maybeSingle();

  if (existingClientErr) {
    const err = new Error(existingClientErr.message || 'client_lookup_failed');
    err.code = existingClientErr.code || 'client_lookup_failed';
    err.hint = existingClientErr.hint || null;
    throw err;
  }

  if (!existingClient) {
    const err = new Error('Selected client was not found.');
    err.code = 'client_not_found';
    err.status = 404;
    throw err;
  }

  return { client_id: existingClient.id, created_client: null };
}

async function findOpenAgreementForClient(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,status,created_at,sent_at')
    .eq('client_id', clientId)
    .in('status', ['draft', 'sent'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message || 'agreement_lookup_failed');
    err.code = error.code || 'agreement_lookup_failed';
    err.hint = error.hint || null;
    throw err;
  }

  return data || null;
}

async function findCurrentSignedAgreementForClient(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,status,client_legal_name,membership_tier,initial_term_start,initial_renewal_date,signed_at,created_at,is_current')
    .eq('client_id', clientId)
    .eq('status', 'signed')
    .eq('is_current', true)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message || 'agreement_lookup_failed');
    err.code = error.code || 'agreement_lookup_failed';
    err.hint = error.hint || null;
    throw err;
  }

  return data || null;
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

function buildBillingInvoiceSyncPayload(stripeInvoice) {
  const statusRaw = String(stripeInvoice?.status || '').trim().toLowerCase();
  const hostedInvoiceUrlRaw = String(stripeInvoice?.hosted_invoice_url || '').trim();
  const totalRaw = Number(stripeInvoice?.total);
  const amountDueRaw = Number(stripeInvoice?.amount_due);
  const amountTotalCents = Number.isFinite(totalRaw)
    ? Math.round(totalRaw)
    : Number.isFinite(amountDueRaw)
      ? Math.round(amountDueRaw)
      : null;
  const currencyRaw = String(stripeInvoice?.currency || '').trim().toLowerCase();

  const payload = {};
  if (statusRaw) payload.status = statusRaw;
  if (hostedInvoiceUrlRaw) payload.hosted_invoice_url = hostedInvoiceUrlRaw;
  if (amountTotalCents !== null) payload.amount_total_cents = amountTotalCents;
  if (currencyRaw) payload.currency = currencyRaw;
  return payload;
}

async function syncBillingInvoicesByStripeIds(stripeInvoiceIds, { request_id, logPrefix }) {
  if (!stripe || !stripe.invoices || !Array.isArray(stripeInvoiceIds) || !stripeInvoiceIds.length) {
    return { attempted: 0, synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const invoiceId of stripeInvoiceIds) {
    const stripeInvoiceId = String(invoiceId || '').trim();
    if (!stripeInvoiceId) continue;
    try {
      const stripeInvoice = await stripe.invoices.retrieve(stripeInvoiceId);
      const payload = buildBillingInvoiceSyncPayload(stripeInvoice);
      if (!Object.keys(payload).length) continue;
      const { data: updatedRows, error: updateErr } = await supabaseAdmin
        .from('billing_invoices')
        .update(payload)
        .eq('stripe_invoice_id', stripeInvoiceId)
        .select('id');
      if (updateErr) {
        failed += 1;
        console.error(`${logPrefix} sync_update_failed`, {
          request_id,
          stripe_invoice_id: stripeInvoiceId,
          error: updateErr.message,
          code: updateErr.code,
          hint: updateErr.hint
        });
        continue;
      }
      if (Array.isArray(updatedRows) && updatedRows.length > 0) synced += 1;
    } catch (syncErr) {
      failed += 1;
      console.error(`${logPrefix} sync_retrieve_failed`, {
        request_id,
        stripe_invoice_id: stripeInvoiceId,
        error: syncErr?.message || syncErr
      });
    }
  }

  return { attempted: stripeInvoiceIds.length, synced, failed };
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

function formatDateForEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const [year, month, day] = raw.split('-');
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

router.get('/agreements/pending', async (req, res) => {
  const request_id = req.request_id || null;
  const clientId = String(req.query?.client_id || '').trim();
  const scopedToClient = clientId && clientId.toLowerCase() !== 'all';
  if (scopedToClient && !UUID_RE.test(clientId)) {
    return res.status(400).json({
      error: 'client_id_required',
      code: 'client_id_required',
      detail: 'client_id must be a valid client id or all.',
      request_id
    });
  }

  try {
    if (scopedToClient) {
      const parentGuard = await requireParentClientForAdminBilling(clientId, { route: 'admin_billing_agreements_pending' });
      if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
    }

    let query = supabaseAdmin
      .from('membership_agreements')
      .select(AGREEMENT_PENDING_SELECT)
      .in('status', ['draft', 'sent', 'signed'])
      .order('created_at', { ascending: false })
      .limit(scopedToClient ? 20 : 100);

    if (scopedToClient) query = query.eq('client_id', clientId);

    const { data, error } = await query;

    if (error) {
      console.error('[billing/agreements/pending] query_failed', {
        request_id,
        client_id: scopedToClient ? clientId : 'all',
        error: error.message,
        code: error.code,
        hint: error.hint
      });
      return res.status(500).json({
        error: 'pending_agreement_lookup_failed',
        code: error.code || 'pending_agreement_lookup_failed',
        detail: error.message,
        hint: error.hint,
        request_id
      });
    }

    const items = (data || []).filter((row) => {
      const status = String(row?.status || '').trim().toLowerCase();
      const checkoutStatus = String(row?.checkout_status || '').trim().toLowerCase();
      if (checkoutStatus === 'paid') return false;
      if (status === 'draft' || status === 'sent') return true;
      return status === 'signed' && (!checkoutStatus || checkoutStatus === 'pending_payment');
    });
    const agreement = items[0] || null;

    return res.json({ ok: true, agreement, items, request_id });
  } catch (e) {
    console.error('[billing/agreements/pending] unexpected', { request_id, client_id: scopedToClient ? clientId : 'all', error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

router.post('/agreements/:id/void', async (req, res) => {
  const request_id = req.request_id || null;
  const agreementId = String(req.params?.id || '').trim();
  if (!UUID_RE.test(agreementId)) {
    return res.status(400).json({
      error: 'agreement_id_required',
      code: 'agreement_id_required',
      detail: 'A valid agreement id is required.',
      request_id
    });
  }

  try {
    const { data: agreement, error: lookupErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,client_id,status,checkout_status,is_current')
      .eq('id', agreementId)
      .maybeSingle();

    if (lookupErr) {
      console.error('[billing/agreements/void] lookup_failed', {
        request_id,
        agreement_id: agreementId,
        error: lookupErr.message,
        code: lookupErr.code,
        hint: lookupErr.hint
      });
      return res.status(500).json({
        error: 'agreement_lookup_failed',
        code: lookupErr.code || 'agreement_lookup_failed',
        detail: lookupErr.message,
        hint: lookupErr.hint,
        request_id
      });
    }

    if (!agreement) {
      return res.status(404).json({
        error: 'agreement_not_found',
        code: 'agreement_not_found',
        detail: 'Agreement was not found.',
        request_id
      });
    }

    const status = String(agreement.status || '').trim().toLowerCase();
    const checkoutStatus = String(agreement.checkout_status || '').trim().toLowerCase();
    const canVoid =
      status === 'sent' ||
      status === 'draft' ||
      (status === 'signed' && (!checkoutStatus || checkoutStatus === 'pending_payment'));

    if (!canVoid) {
      return res.status(409).json({
        error: checkoutStatus === 'paid' ? 'agreement_checkout_already_paid' : 'agreement_not_voidable',
        code: checkoutStatus === 'paid' ? 'agreement_checkout_already_paid' : 'agreement_not_voidable',
        detail: checkoutStatus === 'paid'
          ? 'Paid agreements cannot be voided through this action.'
          : 'Only sent unsigned or signed unpaid agreements can be voided.',
        request_id
      });
    }

    const nowIso = new Date().toISOString();
    const voidedByEmail = String(req.user?.email || req.user?.id || '').trim() || null;
    const voidReason = String(req.body?.void_reason || req.body?.reason || '').trim() || null;
    const { data: voided, error: voidErr } = await supabaseAdmin
      .from('membership_agreements')
      .update({
        status: 'voided',
        is_current: false,
        voided_at: nowIso,
        voided_by_email: voidedByEmail,
        void_reason: voidReason,
        updated_at: nowIso
      })
      .eq('id', agreement.id)
      .select(AGREEMENT_PENDING_SELECT)
      .single();

    if (voidErr) {
      console.error('[billing/agreements/void] update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: voidErr.message,
        code: voidErr.code,
        hint: voidErr.hint
      });
      return res.status(500).json({
        error: 'agreement_void_failed',
        code: voidErr.code || 'agreement_void_failed',
        detail: voidErr.message,
        hint: voidErr.hint,
        request_id
      });
    }

    let restoredAgreement = null;
    if (status === 'signed' && agreement.is_current === true && agreement.client_id) {
      const { data: prior, error: priorErr } = await supabaseAdmin
        .from('membership_agreements')
        .select('id')
        .eq('client_id', agreement.client_id)
        .eq('status', 'superseded')
        .eq('superseded_by_agreement_id', agreement.id)
        .order('signed_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (priorErr) {
        console.error('[billing/agreements/void] prior_lookup_failed', {
          request_id,
          agreement_id: agreement.id,
          client_id: agreement.client_id,
          error: priorErr.message,
          code: priorErr.code,
          hint: priorErr.hint
        });
        return res.status(500).json({
          error: 'agreement_prior_restore_lookup_failed',
          code: priorErr.code || 'agreement_prior_restore_lookup_failed',
          detail: priorErr.message,
          hint: priorErr.hint,
          agreement: voided,
          request_id
        });
      }

      if (prior?.id) {
        const { data: restored, error: restoreErr } = await supabaseAdmin
          .from('membership_agreements')
          .update({
            status: 'signed',
            is_current: true,
            superseded_at: null,
            superseded_by_agreement_id: null,
            updated_at: nowIso
          })
          .eq('id', prior.id)
          .select('id,client_id,status,is_current')
          .single();

        if (restoreErr) {
          console.error('[billing/agreements/void] prior_restore_failed', {
            request_id,
            agreement_id: agreement.id,
            prior_agreement_id: prior.id,
            error: restoreErr.message,
            code: restoreErr.code,
            hint: restoreErr.hint
          });
          return res.status(500).json({
            error: 'agreement_prior_restore_failed',
            code: restoreErr.code || 'agreement_prior_restore_failed',
            detail: restoreErr.message,
            hint: restoreErr.hint,
            agreement: voided,
            request_id
          });
        }
        restoredAgreement = restored || null;
      }
    }

    return res.json({ ok: true, agreement: voided, restored_agreement: restoredAgreement, request_id });
  } catch (e) {
    console.error('[billing/agreements/void] unexpected', { request_id, agreement_id: agreementId, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

router.post('/agreements/preview-html', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const payload = normalizeAgreementPayload(req.body || {});
    const validation = validateAgreementPayload(payload);
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }

    if (payload.client_mode === AGREEMENT_CLIENT_MODE_ATTACH && payload.client_id) {
      const parentGuard = await requireParentClientForAdminBilling(payload.client_id, { route: 'admin_billing_agreements_preview_html' });
      if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
    }

    const { html } = buildMembershipAgreementHtml(payload);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    console.error('[billing/agreements/preview-html] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

async function renderAgreementPreviewPdf(req, res) {
  const request_id = req.request_id || null;
  try {
    const payload = normalizeAgreementPayload(req.body || {});
    const validation = validateAgreementPayload(payload);
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }

    if (payload.client_mode === AGREEMENT_CLIENT_MODE_ATTACH && payload.client_id) {
      const parentGuard = await requireParentClientForAdminBilling(payload.client_id, { route: 'admin_billing_agreements_preview_pdf' });
      if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
    }

    if (payload.client_mode === AGREEMENT_CLIENT_MODE_ATTACH && payload.client_id && !payload.confirm_replace_existing) {
      const currentAgreement = await findCurrentSignedAgreementForClient(payload.client_id);
      if (currentAgreement) {
        return res.status(409).json({
          error: 'agreement_replacement_confirmation_required',
          code: 'agreement_replacement_confirmation_required',
          detail: 'This client already has an active signed agreement. Confirm replacement to continue.',
          existing_agreement: {
            id: currentAgreement.id,
            client_id: currentAgreement.client_id,
            client_legal_name: currentAgreement.client_legal_name || null,
            membership_tier: currentAgreement.membership_tier || null,
            initial_term_start: currentAgreement.initial_term_start || null,
            initial_renewal_date: currentAgreement.initial_renewal_date || null,
            signed_at: currentAgreement.signed_at || null
          },
          request_id
        });
      }
    }

    const { html } = buildMembershipAgreementHtml(payload);
    const pdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="membership-agreement-preview.pdf"');
    return res.send(pdf);
  } catch (e) {
    console.error('[billing/agreements/preview-pdf] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'pdf_render_failed', code: 'pdf_render_failed', detail: e?.message || 'PDF render failed', request_id });
  }
}

router.post('/agreements/preview-pdf', renderAgreementPreviewPdf);
router.post('/agreements/preview', renderAgreementPreviewPdf);

router.post('/agreements/send', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const payload = normalizeAgreementPayload(req.body || {});
    const validation = validateAgreementPayload(payload);
    if (!validation.ok) {
      return res.status(400).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }

    const clientContext = await resolveAgreementClientContext(payload);
    const resolvedClientId = clientContext?.client_id || null;
    if (!resolvedClientId) {
      return res.status(400).json({
        error: 'client_id_required',
        code: 'client_id_required',
        detail: 'A client must be selected or created before sending an agreement.',
        request_id
      });
    }

    const parentGuard = await requireParentClientForAdminBilling(resolvedClientId, { route: 'admin_billing_agreements_send', client_mode: payload.client_mode });
    if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);

    if (payload.client_mode === AGREEMENT_CLIENT_MODE_ATTACH && !payload.confirm_replace_existing) {
      const currentAgreement = await findCurrentSignedAgreementForClient(resolvedClientId);
      if (currentAgreement) {
        return res.status(409).json({
          error: 'agreement_replacement_confirmation_required',
          code: 'agreement_replacement_confirmation_required',
          detail: 'This client already has an active signed agreement. Confirm replacement to continue.',
          existing_agreement: {
            id: currentAgreement.id,
            client_id: currentAgreement.client_id,
            client_legal_name: currentAgreement.client_legal_name || null,
            membership_tier: currentAgreement.membership_tier || null,
            initial_term_start: currentAgreement.initial_term_start || null,
            initial_renewal_date: currentAgreement.initial_renewal_date || null,
            signed_at: currentAgreement.signed_at || null
          },
          request_id
        });
      }
    }

    const openAgreement = await findOpenAgreementForClient(resolvedClientId);
    if (openAgreement) {
      return res.status(409).json({
        error: 'agreement_already_open',
        code: 'agreement_already_open',
        detail: `This client already has an open ${openAgreement.status} agreement (${openAgreement.id}).`,
        open_agreement_id: openAgreement.id,
        open_agreement_status: openAgreement.status,
        request_id
      });
    }

    const payloadWithClient = {
      ...payload,
      client_id: resolvedClientId,
      attached_client_id: resolvedClientId
    };

    const { html, normalized } = buildMembershipAgreementHtml(payloadWithClient);
    const pdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    });

    const agreementId = crypto.randomUUID();
    const clientSlug = slugify(normalized.client_legal_name);
    const draftPdfPath = `membership-agreements/${agreementId}/${clientSlug}-draft.pdf`;

    const upload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(draftPdfPath, pdf, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (upload.error) {
      console.error('[billing/agreements/send] draft_upload_failed', {
        request_id,
        error: upload.error.message,
        code: upload.error.code
      });
      return res.status(500).json({
        error: 'draft_upload_failed',
        code: upload.error.code || 'draft_upload_failed',
        detail: upload.error.message,
        request_id
      });
    }

    const signerToken = crypto.randomBytes(32).toString('hex');
    const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex');
    const signerTokenExpiresAt = new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString();
    const signingUrl = buildMembershipAgreementSignUrl(signerToken);

    const templateSnapshot = {
      template_name: 'membership-agreement',
      template_version: 'membership_agreement_v2_phase1',
      source_document: 'alphaScreen Membership Agreementv2.docx',
      generated_at: new Date().toISOString(),
      client_association: {
        mode: payload.client_mode,
        client_id: resolvedClientId,
        created_client_id: clientContext?.created_client?.id || null,
        candidate_assistance_contact:
          payload.client_mode === AGREEMENT_CLIENT_MODE_ADD
            ? payload.candidate_assistance_contact
            : null
      },
      values: normalized,
      rendered_html: html
    };

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('membership_agreements')
      .insert({
        id: agreementId,
        client_id: resolvedClientId,
        status: 'draft',
        client_legal_name: normalized.client_legal_name,
        dba_trade_name: normalized.dba_trade_name || null,
        primary_admin_name: normalized.primary_admin_name,
        admin_email: normalized.admin_email,
        membership_tier: normalized.membership_tier,
        initial_term_start: normalized.initial_term_start,
        initial_renewal_date: normalized.initial_renewal_date,
        billing_option: normalized.billing_option,
        auto_renew: normalized.auto_renew,
        notice_deadline_days: normalized.notice_deadline_days,
        template_version: 'membership_agreement_v2_phase1',
        template_snapshot: templateSnapshot,
        draft_pdf_path: draftPdfPath,
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: signerTokenExpiresAt,
        created_by_user_id: req.user?.id || null,
        created_by_email: req.user?.email || null
      })
      .select('id,status,admin_email,signer_token_expires_at,draft_pdf_path')
      .single();

    if (insertErr) {
      console.error('[billing/agreements/send] persist_failed', {
        request_id,
        error: insertErr.message,
        code: insertErr.code,
        hint: insertErr.hint
      });
      return res.status(500).json({
        error: 'persist_failed',
        code: insertErr.code || 'persist_failed',
        detail: insertErr.message,
        hint: insertErr.hint,
        request_id
      });
    }

    try {
      await sendMembershipAgreementEmail(normalized.admin_email, signingUrl, {
        client_legal_name: normalized.client_legal_name,
        primary_admin_name: normalized.primary_admin_name,
        membership_tier: normalized.membership_tier,
        expires_on: formatDateForEmail(signerTokenExpiresAt)
      });

      await sendMembershipAgreementInternalNotification(MEMBERSHIP_INTERNAL_NOTIFY_EMAIL, {
        agreement_id: agreementId,
        client_legal_name: normalized.client_legal_name,
        primary_admin_name: normalized.primary_admin_name,
        admin_email: normalized.admin_email,
        membership_tier: normalized.membership_tier,
        billing_option: normalized.billing_option
      });
    } catch (emailErr) {
      console.error('[billing/agreements/send] email_failed', { request_id, error: emailErr?.message || emailErr });
      return res.status(500).json({
        error: 'email_send_failed',
        code: 'email_send_failed',
        detail: extractErrorMessage(emailErr?.message || '', 'Agreement email could not be delivered.'),
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', agreementId)
      .select('id,status,admin_email,signer_token_expires_at,draft_pdf_path,sent_at')
      .single();

    if (updateErr) {
      console.error('[billing/agreements/send] sent_status_update_failed', {
        request_id,
        error: updateErr.message,
        code: updateErr.code,
        hint: updateErr.hint
      });
      return res.status(500).json({
        error: 'status_update_failed',
        code: updateErr.code || 'status_update_failed',
        detail: updateErr.message,
        hint: updateErr.hint,
        request_id
      });
    }

    return res.json({
      ok: true,
      agreement: updated || inserted,
      client: clientContext?.created_client || null,
      request_id
    });
  } catch (e) {
    if (Number(e?.status) === 404 || String(e?.code || '') === 'client_not_found') {
      return res.status(404).json({
        error: 'client_not_found',
        code: 'client_not_found',
        detail: e?.message || 'Selected client was not found.',
        request_id
      });
    }
    console.error('[billing/agreements/send] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: e?.message || 'Server error',
      hint: e?.hint || null,
      request_id
    });
  }
});

router.get('/customers', async (_req, res) => {
  const request_id = _req.request_id || null;
  try {
    const { data, error } = await supabaseAdmin
      .from('billing_customers')
      .select('id,client_id,name,primary_contact_name,primary_contact_email,notes,stripe_customer_id,created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[billing/customers:list] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'list_customers_failed', code: error.code || 'list_customers_failed', detail: error.message, hint: error.hint, request_id });
    }
    return res.json({ items: data || [], request_id });
  } catch (e) {
    console.error('[billing/customers:list] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.post('/customers', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const name = (req.body?.company_name || req.body?.name || '').trim();
    const primary_contact_name = (req.body?.primary_contact_name || '').trim();
    const primary_contact_email = (req.body?.primary_contact_email || '').trim();
    const notes = (req.body?.notes || '').trim();
    const client_id = (req.body?.client_id || '').trim() || null;

    if (!name || !primary_contact_name || !primary_contact_email) {
      return res.status(400).json({ error: 'missing_fields', code: 'missing_fields', detail: 'name, primary_contact_name, primary_contact_email required', request_id });
    }
    if (client_id) {
      const parentGuard = await requireParentClientForAdminBilling(client_id, { route: 'admin_billing_customers_create' });
      if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
    }

    const { data, error } = await supabaseAdmin
      .from('billing_customers')
      .insert({ name, primary_contact_name, primary_contact_email, notes: notes || null, client_id: client_id || null })
      .select('id,client_id,name,primary_contact_name,primary_contact_email,notes,stripe_customer_id,created_at')
      .single();

    if (error) {
      console.error('[billing/customers:create] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'create_customer_failed', code: error.code || 'create_customer_failed', detail: error.message, hint: error.hint, request_id });
    }

    return res.json({ item: data, request_id });
  } catch (e) {
    console.error('[billing/customers:create] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.get('/invoices', async (_req, res) => {
  const request_id = _req.request_id || null;
  try {
    const { data, error } = await supabaseAdmin
      .from('billing_invoices')
      .select(BILLING_INVOICE_SELECT)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      console.error('[billing/invoices:list] failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({ error: 'list_invoices_failed', code: error.code || 'list_invoices_failed', detail: error.message, hint: error.hint, request_id });
    }

    let invoices = data || [];

    const stripeInvoiceIds = Array.from(
      new Set(invoices.map((inv) => String(inv?.stripe_invoice_id || '').trim()).filter(Boolean))
    );
    if (stripeInvoiceIds.length) {
      await syncBillingInvoicesByStripeIds(stripeInvoiceIds, { request_id, logPrefix: '[billing/invoices:list]' });
      const { data: refreshed, error: refreshErr } = await supabaseAdmin
        .from('billing_invoices')
        .select(BILLING_INVOICE_SELECT)
        .order('created_at', { ascending: false })
        .limit(200);
      if (refreshErr) {
        console.error('[billing/invoices:list] refresh_failed', {
          request_id,
          error: refreshErr.message,
          code: refreshErr.code,
          hint: refreshErr.hint
        });
      } else if (Array.isArray(refreshed)) {
        invoices = refreshed;
      }
    }

    const needsEnrichment = (invoices || []).filter((inv) => !inv.customer_name || !inv.customer_email);
    if (needsEnrichment.length) {
      const ids = Array.from(new Set(needsEnrichment.map((inv) => inv.billing_customer_id).filter(Boolean)));
      if (ids.length) {
        const { data: custData, error: custErr } = await supabaseAdmin
          .from('billing_customers')
          .select('id,name,primary_contact_email')
          .in('id', ids);
        if (!custErr && Array.isArray(custData)) {
          const map = Object.fromEntries((custData || []).map((c) => [c.id, c]));
          invoices.forEach((inv) => {
            if (!inv.customer_name || !inv.customer_email) {
              const c = map[inv.billing_customer_id];
              if (c) {
                inv.customer_name = inv.customer_name || c.name || null;
                inv.customer_email = inv.customer_email || c.primary_contact_email || null;
              }
            }
          });
        } else if (custErr) {
          console.error('[billing/invoices:list] customer_enrich_failed', { request_id, error: custErr.message, code: custErr.code, hint: custErr.hint });
        }
      }
    }

    return res.json({ items: invoices || [], request_id });
  } catch (e) {
    console.error('[billing/invoices:list] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.post('/invoices/sync', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    if (!stripe || !stripe.invoices) {
      return res.status(500).json({
        error: 'stripe_unavailable',
        code: 'stripe_unavailable',
        detail: 'Stripe client is unavailable.',
        request_id
      });
    }

    const requestedLimit = Number.parseInt(String(req.body?.limit || '500'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 2000)) : 500;
    const { data: rows, error } = await supabaseAdmin
      .from('billing_invoices')
      .select('id,stripe_invoice_id')
      .not('stripe_invoice_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[billing/invoices:sync] list_failed', { request_id, error: error.message, code: error.code, hint: error.hint });
      return res.status(500).json({
        error: 'sync_list_failed',
        code: error.code || 'sync_list_failed',
        detail: error.message,
        hint: error.hint,
        request_id
      });
    }

    const stripeInvoiceIds = Array.from(
      new Set((rows || []).map((row) => String(row?.stripe_invoice_id || '').trim()).filter(Boolean))
    );
    const syncResult = await syncBillingInvoicesByStripeIds(stripeInvoiceIds, { request_id, logPrefix: '[billing/invoices:sync]' });
    return res.json({ ok: true, ...syncResult, request_id });
  } catch (e) {
    console.error('[billing/invoices:sync] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

router.post('/invoices/send', async (req, res) => {
  const request_id = req.request_id || null;
  try {
    if (!stripe || !stripe.customers || !stripe.invoices || !stripe.invoiceItems) {
      return res.status(500).json({
        error: 'stripe_unavailable',
        code: 'stripe_unavailable',
        detail: 'Stripe client is unavailable.',
        request_id
      });
    }

    let billing_customer_id = String(req.body?.billing_customer_id || '').trim() || null;
    const client_id = String(req.body?.client_id || '').trim() || null;
    const invoice_title = (req.body?.invoice_title || req.body?.title || '').trim();
    const invoice_description = (req.body?.invoice_description || '').trim() || null;
    const days_until_due = Number.isFinite(parseInt(req.body?.days_until_due, 10)) ? parseInt(req.body?.days_until_due, 10) : 7;
    const line_items = Array.isArray(req.body?.line_items) ? req.body.line_items : [];

    if (!invoice_title || (!billing_customer_id && !client_id)) {
      return res.status(400).json({ error: 'missing_fields', code: 'missing_fields', detail: 'client_id (or billing_customer_id) and invoice_title are required', request_id });
    }
    if (client_id) {
      const parentGuard = await requireParentClientForAdminBilling(client_id, { route: 'admin_billing_invoices_send_client' });
      if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
    }

    const normalizedItems = (line_items || []).map((li) => {
      const description = (li?.description || '').trim();
      const qtyRaw = parseInt(li?.quantity, 10);
      const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
      const unitDollars = Number(li?.unit_amount);
      const unit_amount_cents = Math.round(unitDollars * 100);
      const line_total_cents = Number.isFinite(unit_amount_cents) && Number.isFinite(quantity) ? unit_amount_cents * quantity : NaN;
      return {
        description,
        quantity,
        unit_amount_cents,
        line_total_cents
      };
    });

    const invalidLineItem = normalizedItems.some(
      (li) =>
        !li.description ||
        !Number.isFinite(li.quantity) ||
        li.quantity < 1 ||
        !Number.isFinite(li.unit_amount_cents) ||
        li.unit_amount_cents <= 0 ||
        !Number.isFinite(li.line_total_cents) ||
        li.line_total_cents <= 0
    );
    if (invalidLineItem || !normalizedItems.length) {
      return res.status(400).json({ error: 'invalid_line_items', code: 'invalid_line_items', detail: 'Line items contain invalid or negative amounts', request_id });
    }

    const computedSumCents = normalizedItems.reduce((sum, li) => sum + (Number.isFinite(li.line_total_cents) ? li.line_total_cents : 0), 0);

    console.log('[billing/send] normalized_items', { request_id, items: normalizedItems });

    let billingCustomer = null;
    if (billing_customer_id) {
      const { data: fetchedCustomer, error: fetchErr } = await supabaseAdmin
        .from('billing_customers')
        .select('id,client_id,name,primary_contact_name,primary_contact_email,stripe_customer_id')
        .eq('id', billing_customer_id)
        .maybeSingle();
      if (fetchErr) {
        console.error('[billing/send] customer_lookup_failed', { request_id, error: fetchErr.message, code: fetchErr.code, hint: fetchErr.hint });
        return res.status(500).json({ error: 'customer_lookup_failed', code: fetchErr.code || 'customer_lookup_failed', detail: fetchErr.message, hint: fetchErr.hint, request_id });
      }
      billingCustomer = fetchedCustomer || null;
      if (billingCustomer?.client_id) {
        const parentGuard = await requireParentClientForAdminBilling(billingCustomer.client_id, { route: 'admin_billing_invoices_send_billing_customer' });
        if (!parentGuard.ok) return respondWithParentClientGuard(res, parentGuard, request_id);
      }
    } else {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,name,email,client_admin_name')
        .eq('id', client_id)
        .maybeSingle();
      if (clientErr) {
        console.error('[billing/send] client_lookup_failed', { request_id, error: clientErr.message, code: clientErr.code, hint: clientErr.hint });
        return res.status(500).json({ error: 'client_lookup_failed', code: clientErr.code || 'client_lookup_failed', detail: clientErr.message, hint: clientErr.hint, request_id });
      }
      if (!clientRow) {
        return res.status(404).json({ error: 'client_not_found', code: 'client_not_found', detail: 'Client not found', request_id });
      }

      const customerName = String(clientRow.name || '').trim();
      const customerEmail = String(clientRow.email || '').trim();
      const customerContact = String(clientRow.client_admin_name || clientRow.name || '').trim();
      const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);
      if (!customerName || !customerContact || !emailLooksValid) {
        return res.status(400).json({
          error: 'client_billing_data_missing',
          code: 'client_billing_data_missing',
          detail: 'Selected client is missing required billing contact data.',
          request_id
        });
      }

      const { data: existingCustomer, error: existingErr } = await supabaseAdmin
        .from('billing_customers')
        .select('id,name,primary_contact_name,primary_contact_email,stripe_customer_id')
        .eq('client_id', clientRow.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingErr) {
        console.error('[billing/send] customer_lookup_failed', { request_id, error: existingErr.message, code: existingErr.code, hint: existingErr.hint });
        return res.status(500).json({ error: 'customer_lookup_failed', code: existingErr.code || 'customer_lookup_failed', detail: existingErr.message, hint: existingErr.hint, request_id });
      }

      if (existingCustomer) {
        billingCustomer = existingCustomer;
      } else {
        const { data: createdCustomer, error: createErr } = await supabaseAdmin
          .from('billing_customers')
          .insert({
            client_id: clientRow.id,
            name: customerName,
            primary_contact_name: customerContact,
            primary_contact_email: customerEmail,
            notes: null
          })
          .select('id,name,primary_contact_name,primary_contact_email,stripe_customer_id')
          .single();
        if (createErr) {
          console.error('[billing/send] customer_create_failed', { request_id, error: createErr.message, code: createErr.code, hint: createErr.hint });
          return res.status(500).json({ error: 'customer_create_failed', code: createErr.code || 'customer_create_failed', detail: createErr.message, hint: createErr.hint, request_id });
        }
        billingCustomer = createdCustomer || null;
      }

      billing_customer_id = billingCustomer?.id || null;
    }

    if (!billingCustomer || !billing_customer_id) {
      return res.status(404).json({ error: 'customer_not_found', code: 'customer_not_found', detail: 'Billing customer not found', request_id });
    }

    let stripeCustomerId = billingCustomer.stripe_customer_id || null;
    if (!stripeCustomerId) {
      try {
        const sc = await stripe.customers.create({
          name: billingCustomer.name || billingCustomer.primary_contact_name,
          email: billingCustomer.primary_contact_email,
          metadata: {
            billing_customer_id: billingCustomer.id,
            primary_contact_name: billingCustomer.primary_contact_name || ''
          }
        });
        stripeCustomerId = sc.id;
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingCustomer.id);
      } catch (e) {
        console.error('[billing/send] stripe_customer_failed', { request_id, error: e?.message || e });
        return res.status(500).json({ error: 'stripe_customer_failed', code: 'stripe_customer_failed', detail: e?.message || 'Stripe customer creation failed', request_id });
      }
    }

    let draftInvoice = null;
    try {
      draftInvoice = await stripe.invoices.create({
        customer: stripeCustomerId,
        collection_method: 'send_invoice',
        days_until_due: days_until_due || 7,
        auto_advance: false,
        description: invoice_description || undefined,
        metadata: {
          billing_customer_id,
          invoice_title
        }
      });
    } catch (e) {
      console.error('[billing/send] invoice_create_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_create_failed', code: 'invoice_create_failed', detail: e?.message || 'Could not create invoice', request_id });
    }

    try {
      for (const item of normalizedItems) {
        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: draftInvoice.id,
          description: item.description,
          amount: item.line_total_cents,
          currency: 'usd'
        });
      }
    } catch (e) {
      console.error('[billing/send] invoice_items_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_items_failed', code: 'invoice_items_failed', detail: e?.message || 'Could not create invoice items', request_id });
    }

    console.log('[billing/send] invoice_items_attached', {
      request_id,
      invoice_id: draftInvoice?.id || null,
      items: normalizedItems.length,
      total_cents: computedSumCents
    });

    let sentInvoice = draftInvoice;
    try {
      const beforeFinalize = await stripe.invoices.retrieve(draftInvoice.id);
      console.log('[billing/send] stripe_totals_before_finalize', {
        request_id,
        invoice_id: draftInvoice.id,
        amount_due: beforeFinalize?.amount_due,
        total: beforeFinalize?.total
      });
    } catch (e) {
      console.error('[billing/send] invoice_retrieve_before_finalize_failed', { request_id, error: e?.message || e });
    }

    let afterSend = null;
    try {
      const finalized = await stripe.invoices.finalizeInvoice(draftInvoice.id);
      sentInvoice = finalized;
      const sent = await stripe.invoices.sendInvoice(finalized.id);
      sentInvoice = sent || finalized;
      try {
        afterSend = await stripe.invoices.retrieve(finalized.id);
        console.log('[billing/send] stripe_totals_after_send', {
          request_id,
          invoice_id: finalized.id,
          amount_due: afterSend?.amount_due,
          total: afterSend?.total
        });
      } catch (e) {
        console.error('[billing/send] invoice_retrieve_after_send_failed', { request_id, error: e?.message || e });
      }
    } catch (e) {
      console.error('[billing/send] invoice_send_failed', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'invoice_send_failed', code: 'invoice_send_failed', detail: e?.message || 'Could not send invoice', request_id });
    }

    const amount_total_cents = Number.isFinite(afterSend?.amount_due)
      ? afterSend.amount_due
      : Number.isFinite(afterSend?.total)
        ? afterSend.total
        : computedSumCents;

    try {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('billing_invoices')
        .insert({
          billing_customer_id,
          title: invoice_title,
          invoice_title,
          invoice_description: invoice_description || null,
          amount_total_cents,
          currency: 'usd',
          status: sentInvoice?.status || null,
          hosted_invoice_url: sentInvoice?.hosted_invoice_url || null,
          stripe_invoice_id: sentInvoice?.id || null,
          customer_name: billingCustomer.name || null,
          customer_email: billingCustomer.primary_contact_email || null
        })
        .select('id,stripe_invoice_id,status,hosted_invoice_url,invoice_description,amount_total_cents,customer_name,customer_email')
        .single();

      if (insErr) {
        console.error('[billing/send] persist_failed', { request_id, error: insErr.message, code: insErr.code, hint: insErr.hint });
        return res.status(500).json({ error: 'persist_failed', code: insErr.code || 'persist_failed', detail: insErr.message, hint: insErr.hint, request_id });
      }

      return res.json({ ok: true, invoice: inserted, request_id });
    } catch (e) {
      console.error('[billing/send] unexpected_persist', { request_id, error: e?.message || e });
      return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
    }
  } catch (e) {
    console.error('[billing/send] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', code: 'server_error', detail: e?.message || 'Server error', request_id });
  }
});

module.exports = router;

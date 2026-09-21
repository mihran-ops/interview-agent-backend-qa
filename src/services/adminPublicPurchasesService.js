'use strict';

const crypto = require('crypto');
const { buildAlphaScreenPackageSnapshot, normalizeAlphaScreenPlanKey, normalizeBillingInterval } = require('./alphaScreenPackages');
const { buildClientPwResetUrl, buildMembershipAgreementSignUrl } = require('../config/urlConfig');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const READ_LIMIT = 1000;
const SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECOVERY_ACTION_WINDOW_MS = 60 * 1000;
const recoveryActionRateBuckets = new Map();
const VALID_STATUS_KEYS = new Set([
  'signup_started',
  'agreement_pending',
  'signed_unpaid',
  'checkout_pending',
  'setup_pending',
  'completed',
  'failed_payment',
  'canceled',
  'unknown'
]);
const STATUS_LABELS = Object.freeze({
  signup_started: 'Signup Started',
  agreement_pending: 'Agreement Pending',
  signed_unpaid: 'Signed / Unpaid',
  checkout_pending: 'Checkout Pending',
  setup_pending: 'Setup Pending',
  completed: 'Completed',
  failed_payment: 'Failed Payment',
  canceled: 'Canceled',
  unknown: 'Unknown'
});
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const FAILED_SUBSCRIPTION_STATUSES = new Set(['past_due', 'unpaid', 'incomplete_expired']);
const AGREEMENT_LINK_RESEND_STATUS_VALUES = ['sent', 'pending_signature', 'signature_pending'];
const AGREEMENT_LINK_RESEND_STATUSES = new Set(AGREEMENT_LINK_RESEND_STATUS_VALUES);
const INTENT_SELECT_COLUMNS = [
  'id',
  'status',
  'selected_plan_key',
  'selected_billing_cadence',
  'package_snapshot',
  'first_role_prepay_selected',
  'first_role_prepay_amount_cents',
  'first_role_normal_role_fee_cents',
  'first_role_prepay_discount_percent',
  'first_role_prepay_credit_type',
  'company_legal_name',
  'company_dba',
  'buyer_first_name',
  'buyer_last_name',
  'buyer_email',
  'buyer_phone',
  'buyer_title',
  'source_path',
  'channel',
  'created_by_user_id',
  'created_by_email',
  'ghl_contact_id',
  'ghl_opportunity_id',
  'promotion_code',
  'promotion_label',
  'promotion_discount_cents',
  'initial_payment_cents',
  'activated_at',
  'agreement_id',
  'stripe_checkout_session_id',
  'client_id',
  'expires_at',
  'created_at',
  'updated_at'
].join(',');
const AGREEMENT_SELECT_COLUMNS = [
  'id',
  'client_id',
  'status',
  'is_current',
  'checkout_status',
  'checkout_session_id',
  'checkout_created_at',
  'checkout_paid_at',
  'client_legal_name',
  'dba_trade_name',
  'primary_admin_name',
  'admin_email',
  'membership_tier',
  'billing_option',
  'sent_at',
  'opened_at',
  'signed_at',
  'voided_at',
  'superseded_by_agreement_id',
  'created_at',
  'updated_at'
].join(',');
const CLIENT_SELECT_COLUMNS = [
  'id',
  'name',
  'email',
  'client_admin_name',
  'plan_tier',
  'billing_status',
  'billing_interval',
  'stripe_customer_id',
  'stripe_subscription_id',
  'subscription_status',
  'current_term_end',
  'created_at'
].join(',');
const MEMBER_SELECT_COLUMNS = 'client_id,user_id,email,name,role,created_at';
const EMAIL_SELECT_COLUMNS = 'id,email,email_category,category,status,event_type,event_at,created_at,is_problem,custom_args';
const CREDIT_SELECT_COLUMNS = [
  'id',
  'billing_client_id',
  'source_client_id',
  'source_public_purchase_intent_id',
  'source_membership_agreement_id',
  'source_stripe_checkout_session_id',
  'credit_type',
  'membership_key',
  'normal_role_fee_cents',
  'discounted_credit_amount_cents',
  'discount_percent',
  'status',
  'used_at',
  'used_by_role_id',
  'created_at',
  'updated_at'
].join(',');

function trimText(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function lowerText(value, max = 300) {
  return trimText(value, max).toLowerCase();
}

function redactEmail(email) {
  try {
    if (!email) return '';
    const [user, domain] = String(email).split('@');
    if (!domain) return trimText(email, 80);
    if (user.length <= 3) return `${user[0] || ''}***@${domain}`;
    return `${user.slice(0, 2)}***@${domain}`;
  } catch (_) {
    return trimText(email, 80);
  }
}

function defaultEnsureRecovery(args) {
  const { ensureUserAndSendRecovery } = require('./recoveryHelper');
  return ensureUserAndSendRecovery(args);
}

function titleCase(value) {
  const raw = trimText(value, 80);
  if (!raw) return '';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseDateBoundary(value, endOfDay = false) {
  const raw = trimText(value, 40);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoDateOnly(value) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function cleanIdList(values) {
  return Array.from(new Set((values || []).map((value) => trimText(value, 120)).filter(Boolean)));
}

function cleanEmailList(values) {
  return Array.from(new Set((values || []).map((value) => lowerText(value, 254)).filter(Boolean)));
}

function parseDateRange(query = {}, now = new Date()) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const days = parsePositiveInt(query.days || query.date_range, DEFAULT_DAYS, MAX_DAYS);
  const defaultFrom = new Date(safeNow.getTime() - days * 24 * 60 * 60 * 1000);
  const from = parseDateBoundary(query.date_from, false) || defaultFrom;
  const to = parseDateBoundary(query.date_to, true) || safeNow;
  return {
    days,
    from,
    to,
    date_range: trimText(query.date_from) || trimText(query.date_to) ? 'custom' : `${days}d`,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to)
  };
}

function parseFilters(query = {}, now = new Date()) {
  const dateRange = parseDateRange(query, now);
  const status = lowerText(query.status || query.state, 40);
  const membership = lowerText(query.membership || query.plan || query.selected_plan_key, 40);
  const cadence = lowerText(query.cadence || query.billing_cadence || query.selected_billing_cadence, 40);
  return {
    ...dateRange,
    status: VALID_STATUS_KEYS.has(status) ? status : '',
    membership: ['basic', 'pro', 'enterprise'].includes(membership) ? membership : '',
    billing_cadence: ['monthly', 'annual'].includes(cadence) ? cadence : '',
    channel: ['retail', 'sales_assisted'].includes(lowerText(query.channel, 40)) ? lowerText(query.channel, 40) : '',
    representative: lowerText(query.representative || query.created_by_email, 254),
    search: lowerText(query.search || query.q, 160),
    page: parsePositiveInt(query.page, 1, 10000),
    limit: parsePositiveInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT)
  };
}

function applyDateRange(query, column, filters) {
  return query
    .gte(column, filters.date_from)
    .lte(column, filters.date_to);
}

async function runQuery(builder, code, message = 'Could not load public purchase records.') {
  const { data, error } = await builder;
  if (error) {
    const serviceError = new Error(message);
    serviceError.code = code;
    serviceError.status = 503;
    serviceError.detail = error.message || null;
    throw serviceError;
  }
  return Array.isArray(data) ? data : [];
}

async function runMaybeSingle(builder, code, message = 'Could not load public purchase record.') {
  const { data, error } = await builder.maybeSingle();
  if (error) {
    const serviceError = new Error(message);
    serviceError.code = code;
    serviceError.status = 503;
    serviceError.detail = error.message || null;
    throw serviceError;
  }
  return data || null;
}

function makeActionError(status, code, detail) {
  const error = new Error(detail || code);
  error.status = status;
  error.code = code;
  error.detail = detail || code;
  return error;
}

function enforceRecoveryRateLimit({ action, purchaseIntentId, actorEmail, now = new Date(), store = recoveryActionRateBuckets } = {}) {
  const safeAction = trimText(action, 80) || 'unknown';
  const safeIntentId = trimText(purchaseIntentId, 120) || 'unknown';
  const safeActor = lowerText(actorEmail, 254) || 'unknown';
  const key = `${safeActor}:${safeAction}:${safeIntentId}`;
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const existing = store.get(key);
  if (existing && existing > nowMs) {
    throw makeActionError(429, 'rate_limited', 'This recovery action was just sent. Wait a minute before trying again.');
  }
  store.set(key, nowMs + RECOVERY_ACTION_WINDOW_MS);
}

function clearRecoveryRateLimit({ action, purchaseIntentId, actorEmail, store = recoveryActionRateBuckets } = {}) {
  const key = `${lowerText(actorEmail, 254) || 'unknown'}:${trimText(action, 80) || 'unknown'}:${trimText(purchaseIntentId, 120) || 'unknown'}`;
  store.delete(key);
}

function emailSendSucceeded(result) {
  return result?.statusCode === 202;
}

function ensureEmailSent(result, code = 'recovery_email_send_failed') {
  if (emailSendSucceeded(result)) return;
  const detail = result?.skipped ? 'Email delivery is not configured.' : 'Email provider did not accept the recovery email.';
  throw makeActionError(503, code, detail);
}

function appendQueryParam(url, key, value) {
  const raw = trimText(url, 2000);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch (_) {
    const separator = raw.includes('?') ? '&' : '?';
    return `${raw}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function generateSigningLink({ checkoutRecovery = false } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const signingUrl = buildMembershipAgreementSignUrl(token);
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString(),
    url: checkoutRecovery ? appendQueryParam(signingUrl, 'checkout', 'recover') : signingUrl
  };
}

async function readIntentRows(db, filters) {
  let query = db
    .from('public_purchase_intents')
    .select(INTENT_SELECT_COLUMNS);
  query = applyDateRange(query, 'created_at', filters).order('created_at', { ascending: false }).limit(READ_LIMIT);
  if (filters.membership && filters.membership !== 'enterprise') query = query.eq('selected_plan_key', filters.membership);
  if (filters.billing_cadence) query = query.eq('selected_billing_cadence', filters.billing_cadence);
  if (filters.channel) query = query.eq('channel', filters.channel);
  if (filters.representative) query = query.ilike('created_by_email', filters.representative);
  return runQuery(query, 'public_purchase_intents_read_failed');
}

async function readAgreementRows(db, agreementIds) {
  const ids = cleanIdList(agreementIds);
  if (!ids.length) return [];
  let query = db
    .from('membership_agreements')
    .select(AGREEMENT_SELECT_COLUMNS)
    .in('id', ids);
  return runQuery(query, 'public_purchase_agreements_read_failed');
}

async function readClientRows(db, clientIds) {
  const ids = cleanIdList(clientIds);
  if (!ids.length) return [];
  let query = db
    .from('clients')
    .select(CLIENT_SELECT_COLUMNS)
    .in('id', ids);
  return runQuery(query, 'public_purchase_clients_read_failed');
}

async function readMemberRows(db, clientIds) {
  const ids = cleanIdList(clientIds);
  if (!ids.length) return [];
  let query = db
    .from('client_members')
    .select(MEMBER_SELECT_COLUMNS)
    .in('client_id', ids);
  return runQuery(query, 'public_purchase_members_read_failed');
}

async function readWelcomeEmailRows(db, emails, warnings = []) {
  const safeEmails = cleanEmailList(emails);
  if (!safeEmails.length) return [];
  let query = db
    .from('email_delivery_events')
    .select(EMAIL_SELECT_COLUMNS)
    .in('email', safeEmails)
    .in('email_category', ['public_purchase_welcome'])
    .order('created_at', { ascending: false })
    .limit(READ_LIMIT);
  try {
    return await runQuery(query, 'public_purchase_email_events_read_failed');
  } catch (error) {
    warnings.push({
      source: 'email_delivery_events',
      code: trimText(error?.code, 80) || 'public_purchase_email_events_read_failed',
      detail: 'Email delivery summaries are unavailable for this response.'
    });
    return [];
  }
}

async function readCreditRows(db, purchaseIntentIds, warnings = []) {
  const ids = cleanIdList(purchaseIntentIds);
  if (!ids.length) return [];
  let query = db
    .from('client_role_credits')
    .select(CREDIT_SELECT_COLUMNS)
    .in('source_public_purchase_intent_id', ids)
    .limit(READ_LIMIT);
  try {
    return await runQuery(query, 'client_role_credits_read_failed');
  } catch (error) {
    warnings.push({
      source: 'client_role_credits',
      code: trimText(error?.code, 80) || 'client_role_credits_read_failed',
      detail: 'First role prepay credit summaries are unavailable for this response.'
    });
    return [];
  }
}

function mapById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = trimText(row?.id, 120);
    if (id) map.set(id, row);
  }
  return map;
}

function buildMemberMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const clientId = trimText(row?.client_id, 120);
    if (!clientId) continue;
    const existing = map.get(clientId) || [];
    existing.push(row);
    map.set(clientId, existing);
  }
  return map;
}

function emailEventTime(row) {
  return trimText(row?.event_at || row?.created_at, 40);
}

function buildEmailSummaryMap(rows) {
  const byIntentId = new Map();
  const byEmail = new Map();
  for (const row of rows || []) {
    const customArgs = row?.custom_args && typeof row.custom_args === 'object' ? row.custom_args : {};
    const intentId = trimText(customArgs.purchase_intent_id, 120);
    const email = lowerText(row?.email, 254);
    const summary = {
      category: trimText(row?.email_category || row?.category, 80) || 'public_purchase_welcome',
      status: trimText(row?.status || row?.event_type, 80) || 'unknown',
      is_problem: row?.is_problem === true,
      last_event_at: emailEventTime(row) || null
    };
    if (intentId) {
      const existing = byIntentId.get(intentId);
      if (!existing || String(summary.last_event_at || '') > String(existing.last_event_at || '')) byIntentId.set(intentId, summary);
    }
    if (email) {
      const existing = byEmail.get(email);
      if (!existing || String(summary.last_event_at || '') > String(existing.last_event_at || '')) byEmail.set(email, summary);
    }
  }
  return { byIntentId, byEmail };
}

function buildCreditMap(rows) {
  const byIntentId = new Map();
  for (const row of rows || []) {
    const intentId = trimText(row?.source_public_purchase_intent_id, 120);
    if (!intentId) continue;
    const existing = byIntentId.get(intentId);
    if (!existing || String(row?.created_at || '') > String(existing?.created_at || '')) {
      byIntentId.set(intentId, row);
    }
  }
  return { byIntentId };
}

function chooseBuyerMember(members, buyerEmail) {
  const email = lowerText(buyerEmail, 254);
  const rows = Array.isArray(members) ? members : [];
  if (email) {
    const match = rows.find((row) => lowerText(row?.email, 254) === email);
    if (match) return match;
  }
  return rows.find((row) => trimText(row?.user_id, 120)) || rows[0] || null;
}

function resolvePackageSnapshot(intent) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object'
    ? intent.package_snapshot
    : {};
  const planKey = normalizeAlphaScreenPlanKey(snapshot.plan_key || intent?.selected_plan_key);
  const cadence = normalizeBillingInterval(snapshot.billing_cadence || snapshot.platform_fee_billing_cadence || intent?.selected_billing_cadence);
  const fallback = planKey && cadence ? buildAlphaScreenPackageSnapshot(planKey, cadence) : null;
  return { ...(fallback || {}), ...snapshot };
}

function buildMembershipSummary(intent) {
  const snapshot = resolvePackageSnapshot(intent);
  const planKey = trimText(snapshot.plan_key || intent?.selected_plan_key, 40).toLowerCase();
  const cadence = trimText(snapshot.billing_cadence || snapshot.platform_fee_billing_cadence || intent?.selected_billing_cadence, 40).toLowerCase();
  return {
    key: planKey || null,
    display_name: trimText(snapshot.display_name, 80) || titleCase(planKey) || null,
    billing_cadence: cadence || null,
    billing_cadence_display_name: trimText(snapshot.billing_cadence_display_name, 80) || titleCase(cadence) || null,
    platform_fee: Number.isFinite(Number(snapshot.platform_fee)) ? Number(snapshot.platform_fee) : null,
    platform_fee_cents: Number.isFinite(Number(snapshot.platform_fee_cents)) ? Number(snapshot.platform_fee_cents) : null,
    platform_monthly_fee: Number.isFinite(Number(snapshot.platform_monthly_fee)) ? Number(snapshot.platform_monthly_fee) : null,
    platform_annual_fee: Number.isFinite(Number(snapshot.platform_annual_fee)) ? Number(snapshot.platform_annual_fee) : null,
    per_role_fee: Number.isFinite(Number(snapshot.per_role_fee)) ? Number(snapshot.per_role_fee) : null,
    included_interviews: Number.isFinite(Number(snapshot.included_interviews || snapshot.included_interviews_per_role)) ? Number(snapshot.included_interviews || snapshot.included_interviews_per_role) : null,
    interview_duration_minutes: Number.isFinite(Number(snapshot.interview_duration_minutes || snapshot.max_interview_minutes)) ? Number(snapshot.interview_duration_minutes || snapshot.max_interview_minutes) : null,
    additional_interview_price: Number.isFinite(Number(snapshot.additional_interview_price || snapshot.additional_interview_fee || snapshot.overage_price)) ? Number(snapshot.additional_interview_price || snapshot.additional_interview_fee || snapshot.overage_price) : null
  };
}

function firstRolePrepaySnapshot(intent) {
  const snapshot = resolvePackageSnapshot(intent);
  return snapshot.first_role_prepay && typeof snapshot.first_role_prepay === 'object'
    ? snapshot.first_role_prepay
    : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatUsdCents(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(cents / 100);
}

function buildFirstRolePrepaySummary(intent, credit) {
  const snapshot = firstRolePrepaySnapshot(intent);
  const selected = intent?.first_role_prepay_selected === true || snapshot?.selected === true;
  if (!selected) {
    return {
      first_role_prepay_selected: false,
      first_role_prepay_amount_cents: null,
      first_role_normal_role_fee_cents: null,
      first_role_prepay_discount_percent: null,
      first_role_prepay_credit_type: null,
      first_role_credit_status: 'not_selected',
      credit_id: null,
      used_by_role_id: null,
      used_at: null
    };
  }

  const creditStatus = lowerText(credit?.status, 40);
  const mappedStatus = credit?.id
    ? (creditStatus === 'unused' || creditStatus === 'used' ? creditStatus : 'unknown')
    : 'unknown';
  return {
    first_role_prepay_selected: true,
    first_role_prepay_amount_cents: numberOrNull(credit?.discounted_credit_amount_cents ?? intent?.first_role_prepay_amount_cents ?? snapshot?.discounted_credit_amount_cents),
    first_role_normal_role_fee_cents: numberOrNull(credit?.normal_role_fee_cents ?? intent?.first_role_normal_role_fee_cents ?? snapshot?.normal_role_fee_cents),
    first_role_prepay_discount_percent: numberOrNull(credit?.discount_percent ?? intent?.first_role_prepay_discount_percent ?? snapshot?.discount_percent),
    first_role_prepay_credit_type: trimText(credit?.credit_type || intent?.first_role_prepay_credit_type || snapshot?.credit_type, 80) || 'first_role_prepay',
    first_role_credit_status: mappedStatus,
    credit_id: trimText(credit?.id, 120) || null,
    used_by_role_id: trimText(credit?.used_by_role_id, 120) || null,
    used_at: trimText(credit?.used_at, 40) || null
  };
}

function isActiveClient(client) {
  const billingStatus = lowerText(client?.billing_status, 80);
  const subscriptionStatus = lowerText(client?.subscription_status, 80);
  return billingStatus === 'active' && (!subscriptionStatus || LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus));
}

function mapPublicPurchaseStatus({ intent, agreement, client, member } = {}) {
  const intentStatus = lowerText(intent?.status, 80);
  const agreementStatus = lowerText(agreement?.status, 80);
  const checkoutStatus = lowerText(agreement?.checkout_status, 80);
  const billingStatus = lowerText(client?.billing_status, 80);
  const subscriptionStatus = lowerText(client?.subscription_status, 80);
  const memberLinked = Boolean(trimText(member?.user_id, 120));

  let key = 'unknown';
  if (intentStatus === 'canceled' || intentStatus === 'expired' || agreementStatus === 'voided' || trimText(agreement?.voided_at, 40)) {
    key = 'canceled';
  } else if (FAILED_SUBSCRIPTION_STATUSES.has(subscriptionStatus) || billingStatus === 'past_due') {
    key = 'failed_payment';
  } else if (intentStatus === 'completed' || checkoutStatus === 'paid' || isActiveClient(client)) {
    key = isActiveClient(client) && memberLinked ? 'completed' : 'setup_pending';
  } else if (intentStatus === 'checkout_pending' || checkoutStatus === 'pending_payment') {
    key = 'checkout_pending';
  } else if (agreementStatus === 'signed') {
    key = 'signed_unpaid';
  } else if (intentStatus === 'agreement_pending' || AGREEMENT_LINK_RESEND_STATUSES.has(agreementStatus) || agreementStatus === 'draft') {
    key = 'agreement_pending';
  } else if (intentStatus === 'pending') {
    key = 'signup_started';
  }

  return {
    key,
    label: STATUS_LABELS[key] || STATUS_LABELS.unknown
  };
}

function buildAgreementLinkResendEligibility({ intent, agreement, item } = {}) {
  if (!agreement?.id) {
    return {
      eligible: false,
      code: 'agreement_missing',
      detail: 'This purchase does not have an agreement yet.'
    };
  }

  const status = lowerText(agreement.status, 80);
  const mappedStatus = lowerText(item?.status?.key || mapPublicPurchaseStatus({ intent, agreement }).key, 80);
  if (trimText(agreement.voided_at, 40) || status === 'voided') {
    return {
      eligible: false,
      code: 'agreement_voided',
      detail: 'This agreement is voided.'
    };
  }
  if (status === 'canceled' || status === 'cancelled') {
    return {
      eligible: false,
      code: 'agreement_canceled',
      detail: 'This agreement is canceled.'
    };
  }
  if (trimText(agreement.superseded_by_agreement_id, 120)) {
    return {
      eligible: false,
      code: 'agreement_superseded',
      detail: 'This agreement is superseded.'
    };
  }
  if (status === 'signed' || trimText(agreement.signed_at, 40)) {
    return {
      eligible: false,
      code: 'agreement_already_signed',
      detail: 'Agreement link can only be resent before signature.'
    };
  }
  if (lowerText(agreement.checkout_status, 80) === 'paid' || trimText(agreement.checkout_paid_at, 40)) {
    return {
      eligible: false,
      code: 'agreement_paid',
      detail: 'This agreement has already completed checkout.'
    };
  }
  if (mappedStatus && mappedStatus !== 'agreement_pending') {
    return {
      eligible: false,
      code: 'not_agreement_pending',
      detail: 'Agreement link can only be resent for an agreement-pending public purchase.'
    };
  }
  if (!AGREEMENT_LINK_RESEND_STATUSES.has(status)) {
    return {
      eligible: false,
      code: 'not_agreement_pending',
      detail: 'Agreement link can only be resent for an agreement-pending sent agreement awaiting signature.'
    };
  }

  const recipient = lowerText(intent?.buyer_email || agreement.admin_email, 254);
  if (!recipient) {
    return {
      eligible: false,
      code: 'recipient_missing',
      detail: 'No agreement email recipient was found for this purchase.'
    };
  }

  return {
    eligible: true,
    code: 'eligible',
    detail: 'Agreement link can be resent.',
    recipient
  };
}

function matchesSearch(item, search) {
  const needle = lowerText(search, 160);
  if (!needle) return true;
  return [
    item?.company?.legal_name,
    item?.company?.dba,
    item?.buyer?.email,
    item?.buyer?.name,
    item?.agreement?.id,
    item?.payment?.stripe_checkout_session_id,
    item?.account_setup?.client_id
  ].some((value) => lowerText(value, 300).includes(needle));
}

function buildSupportSummary(item) {
  const statusKey = lowerText(item?.status?.key, 80);
  const workflowNote = statusKey === 'agreement_pending'
    ? 'Next step: agreement sent; buyer signature is pending. Checkout is unavailable until the agreement is signed.'
    : statusKey === 'setup_pending'
      ? 'Next step: payment appears complete; password setup or member user linking is pending.'
      : '';
  const lines = [
    'alphaScreen public purchase support summary',
    `Status: ${trimText(item?.status?.label || item?.status?.key, 80) || 'Unknown'}`,
    `Company: ${trimText(item?.company?.legal_name, 160) || 'Not available'}`,
    item?.company?.dba ? `DBA: ${trimText(item.company.dba, 160)}` : '',
    `Buyer email: ${trimText(item?.buyer?.email, 254) || 'Not available'}`,
    `Membership: ${trimText(item?.membership?.display_name, 80) || trimText(item?.membership?.key, 40) || 'Not available'}`,
    `Cadence: ${trimText(item?.membership?.billing_cadence, 40) || 'Not available'}`,
    firstRolePrepaySupportLine(item?.first_role_prepay),
    `Agreement status: ${trimText(item?.agreement?.status, 80) || 'Not available'}`,
    `Payment status: ${trimText(item?.payment?.checkout_status || item?.payment?.billing_status, 80) || 'Not available'}`,
    `Setup status: ${item?.account_setup?.member_user_linked ? 'member linked' : item?.account_setup?.member_found ? 'member pending user link' : 'member not found'}`,
    workflowNote,
    `Last updated: ${trimText(item?.updated_at || item?.created_at, 40) || 'Not available'}`,
    `Purchase intent ID: ${trimText(item?.purchase_intent_id, 120) || 'Not available'}`,
    `Agreement ID: ${trimText(item?.agreement?.id, 120) || 'Not available'}`,
    `Client ID: ${trimText(item?.account_setup?.client_id, 120) || 'Not available'}`
  ].filter(Boolean);
  return lines.join('\n');
}

function firstRolePrepaySupportLine(prepay) {
  if (!prepay?.first_role_prepay_selected) return 'First role prepay: Not selected';
  const amount = formatUsdCents(prepay.first_role_prepay_amount_cents) || 'selected amount';
  if (prepay.first_role_credit_status === 'unused') return `First role prepay: Selected - ${amount} credit unused`;
  if (prepay.first_role_credit_status === 'used') {
    const roleId = trimText(prepay.used_by_role_id, 120) || 'unknown role';
    const usedAt = trimText(prepay.used_at, 40) || 'date unavailable';
    return `First role prepay: Selected - ${amount} credit used by role ${roleId} on ${usedAt}`;
  }
  return `First role prepay: Selected - ${amount} credit status unknown`;
}

function sanitizePurchaseItem({ intent, agreement, client, member, emailSummary, firstRoleCredit }) {
  const buyerFirst = trimText(intent?.buyer_first_name, 80);
  const buyerLast = trimText(intent?.buyer_last_name, 80);
  const buyerName = [buyerFirst, buyerLast].filter(Boolean).join(' ');
  const membership = buildMembershipSummary(intent);
  const status = mapPublicPurchaseStatus({ intent, agreement, client, member });
  const firstRolePrepay = buildFirstRolePrepaySummary(intent, firstRoleCredit);
  const item = {
    id: trimText(intent?.id, 120),
    purchase_intent_id: trimText(intent?.id, 120),
    status,
    company: {
      legal_name: trimText(intent?.company_legal_name || agreement?.client_legal_name || client?.name, 160) || null,
      dba: trimText(intent?.company_dba || agreement?.dba_trade_name, 160) || null
    },
    buyer: {
      first_name: buyerFirst || null,
      last_name: buyerLast || null,
      name: buyerName || trimText(agreement?.primary_admin_name || client?.client_admin_name, 160) || null,
      email: lowerText(intent?.buyer_email || agreement?.admin_email || client?.email, 254) || null,
      phone: trimText(intent?.buyer_phone, 40) || null,
      title: trimText(intent?.buyer_title, 120) || null
    },
    membership,
    first_role_prepay: firstRolePrepay,
    source: {
      path: trimText(intent?.source_path, 300) || null,
      channel: trimText(intent?.channel, 40) || 'retail',
      representative_user_id: trimText(intent?.created_by_user_id, 120) || null,
      representative_email: lowerText(intent?.created_by_email, 254) || null,
      ghl_contact_id: trimText(intent?.ghl_contact_id, 160) || null,
      ghl_opportunity_id: trimText(intent?.ghl_opportunity_id, 160) || null
    },
    sales_pricing: {
      promotion_code: trimText(intent?.promotion_code, 80) || null,
      promotion_label: trimText(intent?.promotion_label, 160) || null,
      promotion_discount_cents: Number(intent?.promotion_discount_cents || 0),
      initial_payment_cents: Number(intent?.initial_payment_cents || 0)
    },
    agreement: agreement ? {
      id: trimText(agreement.id, 120),
      status: trimText(agreement.status, 80) || null,
      is_current: agreement.is_current !== false,
      checkout_status: trimText(agreement.checkout_status, 80) || null,
      checkout_session_id: trimText(agreement.checkout_session_id, 255) || null,
      sent_at: trimText(agreement.sent_at, 40) || null,
      opened_at: trimText(agreement.opened_at, 40) || null,
      signed_at: trimText(agreement.signed_at, 40) || null,
      voided_at: trimText(agreement.voided_at, 40) || null,
      created_at: trimText(agreement.created_at, 40) || null,
      updated_at: trimText(agreement.updated_at, 40) || null
    } : null,
    payment: {
      checkout_status: trimText(agreement?.checkout_status, 80) || null,
      checkout_created_at: trimText(agreement?.checkout_created_at, 40) || null,
      checkout_paid_at: trimText(agreement?.checkout_paid_at, 40) || null,
      stripe_checkout_session_id: trimText(intent?.stripe_checkout_session_id || agreement?.checkout_session_id, 255) || null,
      stripe_customer_id: trimText(client?.stripe_customer_id, 255) || null,
      stripe_subscription_id: trimText(client?.stripe_subscription_id, 255) || null,
      billing_status: trimText(client?.billing_status, 80) || null,
      subscription_status: trimText(client?.subscription_status, 80) || null,
      current_term_end: trimText(client?.current_term_end, 40) || null
    },
    account_setup: {
      client_id: trimText(intent?.client_id || agreement?.client_id || client?.id, 120) || null,
      client_name: trimText(client?.name, 160) || null,
      member_found: Boolean(member),
      member_user_linked: Boolean(trimText(member?.user_id, 120)),
      member_role: trimText(member?.role, 80) || null,
      member_created_at: trimText(member?.created_at, 40) || null
    },
    email_delivery: {
      welcome_email: emailSummary || null,
      setup_email: { status: 'not_tracked' }
    },
    expires_at: trimText(intent?.expires_at, 40) || null,
    created_at: trimText(intent?.created_at, 40) || null,
    updated_at: trimText(intent?.updated_at, 40) || null,
    activated_at: trimText(intent?.activated_at, 40) || null
  };
  const agreementLinkEligibility = buildAgreementLinkResendEligibility({ intent, agreement, item });
  item.recovery_actions = {
    resend_agreement_link: {
      eligible: agreementLinkEligibility.eligible === true,
      reason: agreementLinkEligibility.code
    }
  };
  item.support_summary = buildSupportSummary(item);
  return item;
}

function buildSummary(items) {
  const counts = {
    total: items.length,
    started: 0,
    signup_started: 0,
    agreement_pending: 0,
    signed_unpaid: 0,
    checkout_pending: 0,
    setup_pending: 0,
    completed: 0,
    failed_payment: 0,
    canceled: 0,
    failed_canceled: 0,
    unknown: 0
  };
  for (const item of items) {
    const key = item?.status?.key || 'unknown';
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.unknown += 1;
  }
  counts.started = counts.signup_started;
  counts.failed_canceled = counts.failed_payment + counts.canceled;
  return counts;
}

function paginate(items, page, limit) {
  const total = items.length;
  const offset = (page - 1) * limit;
  const pageItems = items.slice(offset, offset + limit);
  return {
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
    returned: pageItems.length,
    has_more: offset + pageItems.length < total,
    items: pageItems
  };
}

async function loadPublicPurchaseRecoveryContext(db, purchaseIntentId) {
  const id = trimText(purchaseIntentId, 120);
  if (!id) throw makeActionError(400, 'purchase_intent_id_required', 'Purchase intent id is required.');

  const intent = await runMaybeSingle(
    db.from('public_purchase_intents').select(INTENT_SELECT_COLUMNS).eq('id', id),
    'public_purchase_intent_lookup_failed',
    'Could not load public purchase.'
  );
  if (!intent) throw makeActionError(404, 'public_purchase_not_found', 'Public purchase was not found.');

  let agreement = null;
  if (trimText(intent.agreement_id, 120)) {
    agreement = await runMaybeSingle(
      db.from('membership_agreements').select(`${AGREEMENT_SELECT_COLUMNS},signer_token_expires_at`).eq('id', intent.agreement_id),
      'public_purchase_agreement_lookup_failed',
      'Could not load purchase agreement.'
    );
  }

  const clientId = trimText(intent.client_id || agreement?.client_id, 120);
  let client = null;
  if (clientId) {
    client = await runMaybeSingle(
      db.from('clients').select(CLIENT_SELECT_COLUMNS).eq('id', clientId),
      'public_purchase_client_lookup_failed',
      'Could not load purchase client.'
    );
  }

  const members = clientId
    ? await readMemberRows(db, [clientId])
    : [];
  const member = chooseBuyerMember(members, intent.buyer_email || agreement?.admin_email || client?.email);
  const item = sanitizePurchaseItem({ intent, agreement, client, member, emailSummary: null });

  return { intent, agreement, client, members, member, item };
}

function requirePaidPurchaseContext(context) {
  const checkoutPaid = lowerText(context?.agreement?.checkout_status, 80) === 'paid';
  const intentCompleted = lowerText(context?.intent?.status, 80) === 'completed';
  if (!checkoutPaid && !intentCompleted) {
    throw makeActionError(409, 'purchase_not_paid', 'This recovery action requires a paid public purchase.');
  }
  if (!trimText(context?.client?.id || context?.intent?.client_id || context?.agreement?.client_id, 120)) {
    throw makeActionError(409, 'purchase_client_missing', 'This purchase is not linked to a client yet.');
  }
}

function requireSetupEmailEligible(context) {
  requirePaidPurchaseContext(context);
  const statusKey = context?.item?.status?.key || 'unknown';
  if (!['setup_pending', 'completed'].includes(statusKey)) {
    throw makeActionError(409, 'setup_email_not_eligible', 'Password setup email can only be resent after payment is complete.');
  }
  if (!context?.member) {
    throw makeActionError(409, 'setup_member_missing', 'No buyer member record was found for this paid purchase.');
  }
  const email = lowerText(context?.member?.email || context?.intent?.buyer_email || context?.agreement?.admin_email, 254);
  if (!email) throw makeActionError(409, 'setup_recipient_missing', 'No setup email recipient was found for this purchase.');
  return email;
}

function requireWelcomeEmailEligible(context) {
  requirePaidPurchaseContext(context);
  const statusKey = context?.item?.status?.key || 'unknown';
  if (!['setup_pending', 'completed'].includes(statusKey)) {
    throw makeActionError(409, 'welcome_email_not_eligible', 'Welcome email can only be resent after payment is complete.');
  }
  if (!context?.client?.id) {
    throw makeActionError(409, 'welcome_client_missing', 'No client record was found for this public purchase.');
  }
  const email = lowerText(context?.intent?.buyer_email || context?.agreement?.admin_email || context?.client?.email, 254);
  if (!email) throw makeActionError(409, 'welcome_recipient_missing', 'No welcome email recipient was found for this purchase.');
  return email;
}

function requireCheckoutLinkEligible(context) {
  const agreement = context?.agreement;
  if (!agreement?.id) throw makeActionError(409, 'agreement_missing', 'This purchase does not have an agreement yet.');
  if (lowerText(agreement.status, 80) !== 'signed' || agreement.is_current !== true) {
    throw makeActionError(409, 'agreement_not_signed', 'Checkout recovery link can only be sent for a signed current agreement.');
  }
  if (lowerText(agreement.checkout_status, 80) === 'paid') {
    throw makeActionError(409, 'agreement_already_paid', 'Checkout is already completed for this agreement.');
  }
  if (trimText(agreement.voided_at, 40) || lowerText(agreement.status, 80) === 'voided' || trimText(agreement.superseded_by_agreement_id, 120)) {
    throw makeActionError(409, 'agreement_not_current', 'This agreement is voided or superseded.');
  }
  if (!context?.intent?.id) {
    throw makeActionError(409, 'purchase_intent_missing', 'This checkout recovery action requires a linked public purchase intent.');
  }
  const email = lowerText(context?.intent?.buyer_email || agreement.admin_email, 254);
  if (!email) throw makeActionError(409, 'checkout_recipient_missing', 'No checkout email recipient was found for this purchase.');
  return email;
}

function requireAgreementLinkEligible(context) {
  const eligibility = buildAgreementLinkResendEligibility(context);
  if (!eligibility.eligible) {
    throw makeActionError(409, eligibility.code, eligibility.detail);
  }
  return eligibility.recipient;
}

async function recordAdminRecoveryEmailEvent({ db, context, action, email, status, result, actorEmail, nowIso }) {
  try {
    const { error } = await db
      .from('email_delivery_events')
      .insert({
        event_type: `admin_${action}`,
        event_at: nowIso,
        email,
        category: action,
        email_category: action.includes('welcome') ? 'public_purchase_welcome' : action,
        custom_args: {
          source: 'admin_public_purchase_recovery',
          action,
          actor_email: lowerText(actorEmail, 254) || null,
          purchase_intent_id: trimText(context?.intent?.id, 120) || null,
          agreement_id: trimText(context?.agreement?.id, 120) || null,
          client_id: trimText(context?.client?.id || context?.intent?.client_id || context?.agreement?.client_id, 120) || null
        },
        status,
        response: result?.skipped ? 'skipped' : result?.statusCode ? `status:${result.statusCode}` : null,
        raw_payload: {
          source: 'admin_public_purchase_recovery',
          action,
          purchase_intent_id: trimText(context?.intent?.id, 120) || null,
          agreement_id: trimText(context?.agreement?.id, 120) || null,
          client_id: trimText(context?.client?.id || context?.intent?.client_id || context?.agreement?.client_id, 120) || null
        },
        is_problem: status !== 'sent',
        is_time_sensitive: false
      });
    return error ? { recorded: false, error: error.message || 'email_event_insert_failed' } : { recorded: true };
  } catch (error) {
    return { recorded: false, error: error?.message || 'email_event_insert_failed' };
  }
}

async function resendPublicPurchaseSetupEmail(options = {}) {
  const db = options.db;
  const authAdmin = options.authAdmin;
  const purchaseIntentId = trimText(options.purchaseIntentId, 120);
  const actorEmail = lowerText(options.actorEmail, 254);
  const requestId = trimText(options.requestId, 120) || null;
  const logger = options.logger || console;
  const ensureRecovery = options.ensureRecovery || defaultEnsureRecovery;
  const sendRecoveryEmail = options.sendRecoveryEmail;
  const rateLimitStore = options.rateLimitStore || recoveryActionRateBuckets;
  if (!db || typeof db.from !== 'function') throw makeActionError(500, 'database_client_required', 'Database client is required.');
  if (!authAdmin && !options.ensureRecovery) throw makeActionError(500, 'auth_admin_required', 'Auth admin client is required.');
  if (typeof sendRecoveryEmail !== 'function') throw makeActionError(500, 'recovery_mailer_required', 'Recovery email sender is required.');

  enforceRecoveryRateLimit({ action: 'resend_setup_email', purchaseIntentId, actorEmail, store: rateLimitStore });
  try {
    const context = await loadPublicPurchaseRecoveryContext(db, purchaseIntentId);
    const recipient = requireSetupEmailEligible(context);
    const clientId = trimText(context.client?.id || context.intent.client_id || context.agreement?.client_id, 120);
    const redirectTo = buildClientPwResetUrl({
      origin: 'admin_public_purchase_recovery',
      checkout: 'success',
      client_id: clientId
    });
    const ensured = await ensureRecovery({
      email: recipient,
      redirectTo,
      request_id: requestId,
      loggerPrefix: '[admin/public-purchases/resend-setup-email]'
    });
    const userId = trimText(ensured?.userId, 120);
    if (userId && context.member && !trimText(context.member.user_id, 120)) {
      const { error } = await db
        .from('client_members')
        .update({ user_id: userId })
        .eq('client_id', clientId)
        .eq('email', recipient);
      if (error) throw makeActionError(503, 'setup_member_link_failed', 'Could not link the buyer member to the recovered user.');
    }
    const actionLink = trimText(ensured?.actionLink, 2000);
    if (!actionLink) throw makeActionError(503, 'setup_link_unavailable', 'Could not create a password setup link.');
    const emailResult = await sendRecoveryEmail(recipient, actionLink, context.item?.buyer?.name || recipient);
    ensureEmailSent(emailResult, 'setup_email_send_failed');
    logger.info?.('[admin/public-purchases] setup_email_resent', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail)
    });
    return {
      ok: true,
      sent: true,
      recipient,
      message: 'Password setup email sent.',
      request_id: requestId
    };
  } catch (error) {
    clearRecoveryRateLimit({ action: 'resend_setup_email', purchaseIntentId, actorEmail, store: rateLimitStore });
    throw error;
  }
}

async function resendPublicPurchaseWelcomeEmail(options = {}) {
  const db = options.db;
  const purchaseIntentId = trimText(options.purchaseIntentId, 120);
  const actorEmail = lowerText(options.actorEmail, 254);
  const requestId = trimText(options.requestId, 120) || null;
  const logger = options.logger || console;
  const sendWelcomeEmail = options.sendWelcomeEmail;
  const rateLimitStore = options.rateLimitStore || recoveryActionRateBuckets;
  if (!db || typeof db.from !== 'function') throw makeActionError(500, 'database_client_required', 'Database client is required.');
  if (typeof sendWelcomeEmail !== 'function') throw makeActionError(500, 'welcome_mailer_required', 'Welcome email sender is required.');

  enforceRecoveryRateLimit({ action: 'resend_welcome_email', purchaseIntentId, actorEmail, store: rateLimitStore });
  try {
    const context = await loadPublicPurchaseRecoveryContext(db, purchaseIntentId);
    const recipient = requireWelcomeEmailEligible(context);
    const emailResult = await sendWelcomeEmail(recipient, {
      firstName: context.intent?.buyer_first_name || context.item?.buyer?.name || '',
      clientId: context.client?.id || context.intent?.client_id || context.agreement?.client_id || '',
      agreementId: context.agreement?.id || '',
      purchaseIntentId: context.intent?.id || ''
    });
    ensureEmailSent(emailResult, 'welcome_email_send_failed');
    const nowIso = new Date().toISOString();
    const ledger = await recordAdminRecoveryEmailEvent({
      db,
      context,
      action: 'admin_public_purchase_welcome_resend',
      email: recipient,
      status: 'sent',
      result: emailResult,
      actorEmail,
      nowIso
    });
    logger.info?.('[admin/public-purchases] welcome_email_resent', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail),
      ledger_recorded: ledger.recorded
    });
    return {
      ok: true,
      sent: true,
      recipient,
      message: 'Welcome email sent.',
      email_event_recorded: ledger.recorded,
      request_id: requestId
    };
  } catch (error) {
    clearRecoveryRateLimit({ action: 'resend_welcome_email', purchaseIntentId, actorEmail, store: rateLimitStore });
    throw error;
  }
}

async function resendPublicPurchaseCheckoutLink(options = {}) {
  const db = options.db;
  const purchaseIntentId = trimText(options.purchaseIntentId, 120);
  const actorEmail = lowerText(options.actorEmail, 254);
  const requestId = trimText(options.requestId, 120) || null;
  const logger = options.logger || console;
  const sendCheckoutEmail = options.sendCheckoutEmail;
  const rateLimitStore = options.rateLimitStore || recoveryActionRateBuckets;
  if (!db || typeof db.from !== 'function') throw makeActionError(500, 'database_client_required', 'Database client is required.');
  if (typeof sendCheckoutEmail !== 'function') throw makeActionError(500, 'checkout_mailer_required', 'Checkout email sender is required.');

  enforceRecoveryRateLimit({ action: 'resend_checkout_link', purchaseIntentId, actorEmail, store: rateLimitStore });
  try {
    const context = await loadPublicPurchaseRecoveryContext(db, purchaseIntentId);
    const recipient = requireCheckoutLinkEligible(context);
    const recovery = generateSigningLink({ checkoutRecovery: true });
    const { error: updateError } = await db
      .from('membership_agreements')
      .update({
        signer_token_hash: recovery.tokenHash,
        signer_token_expires_at: recovery.expiresAt,
        updated_at: new Date().toISOString()
      })
      .eq('id', context.agreement.id)
      .eq('status', 'signed');
    if (updateError) throw makeActionError(503, 'checkout_link_refresh_failed', 'Could not prepare the checkout recovery link.');

    const emailResult = await sendCheckoutEmail(recipient, recovery.url, context.item?.buyer?.name || recipient);
    ensureEmailSent(emailResult, 'checkout_link_email_send_failed');
    logger.info?.('[admin/public-purchases] checkout_link_resent', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      agreement_id: context.agreement.id,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail)
    });
    return {
      ok: true,
      sent: true,
      recipient,
      message: 'Checkout recovery link sent.',
      expires_at: recovery.expiresAt,
      request_id: requestId
    };
  } catch (error) {
    clearRecoveryRateLimit({ action: 'resend_checkout_link', purchaseIntentId, actorEmail, store: rateLimitStore });
    throw error;
  }
}

async function resendPublicPurchaseAgreementLink(options = {}) {
  const db = options.db;
  const purchaseIntentId = trimText(options.purchaseIntentId, 120);
  const actorEmail = lowerText(options.actorEmail, 254);
  const requestId = trimText(options.requestId, 120) || null;
  const logger = options.logger || console;
  const sendAgreementEmail = options.sendAgreementEmail;
  const rateLimitStore = options.rateLimitStore || recoveryActionRateBuckets;
  if (!db || typeof db.from !== 'function') throw makeActionError(500, 'database_client_required', 'Database client is required.');
  if (typeof sendAgreementEmail !== 'function') throw makeActionError(500, 'agreement_mailer_required', 'Agreement email sender is required.');

  enforceRecoveryRateLimit({ action: 'resend_agreement_link', purchaseIntentId, actorEmail, store: rateLimitStore });
  let context = null;
  let recipient = '';
  try {
    context = await loadPublicPurchaseRecoveryContext(db, purchaseIntentId);
    recipient = requireAgreementLinkEligible(context);
    logger.info?.('[admin/public-purchases] agreement_link_resend_eligible', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      agreement_id: context.agreement.id,
      agreement_status: lowerText(context.agreement.status, 80) || null,
      agreement_is_current: context.agreement.is_current !== false,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail)
    });
    const recovery = generateSigningLink();
    const { data: refreshedAgreement, error: updateError } = await db
      .from('membership_agreements')
      .update({
        signer_token_hash: recovery.tokenHash,
        signer_token_expires_at: recovery.expiresAt,
        updated_at: new Date().toISOString()
      })
      .eq('id', context.agreement.id)
      .in('status', AGREEMENT_LINK_RESEND_STATUS_VALUES)
      .select('id')
      .maybeSingle();
    if (updateError || !refreshedAgreement?.id) throw makeActionError(503, 'agreement_link_refresh_failed', 'Could not prepare the agreement link.');

    logger.info?.('[admin/public-purchases] agreement_link_send_attempt', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      agreement_id: context.agreement.id,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail)
    });
    let emailResult;
    try {
      emailResult = await sendAgreementEmail(recipient, recovery.url, {
        clientLegalName: context.agreement.client_legal_name || context.intent.company_legal_name,
        primaryAdmin: context.agreement.primary_admin_name || context.item?.buyer?.name || '',
        membershipTier: context.agreement.membership_tier || context.intent.selected_plan_key,
        expiresOn: recovery.expiresAt
      });
    } catch (sendError) {
      const error = makeActionError(503, 'agreement_link_email_send_failed', 'Email provider did not accept the agreement email.');
      error.cause = sendError;
      throw error;
    }
    ensureEmailSent(emailResult, 'agreement_link_email_send_failed');
    logger.info?.('[admin/public-purchases] agreement_link_resent', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      agreement_id: context.agreement.id,
      recipient: redactEmail(recipient),
      actor: redactEmail(actorEmail)
    });
    return {
      ok: true,
      sent: true,
      recipient,
      message: 'Agreement link sent.',
      expires_at: recovery.expiresAt,
      request_id: requestId
    };
  } catch (error) {
    clearRecoveryRateLimit({ action: 'resend_agreement_link', purchaseIntentId, actorEmail, store: rateLimitStore });
    logger.warn?.('[admin/public-purchases] agreement_link_resend_failed', {
      request_id: requestId,
      purchase_intent_id: purchaseIntentId,
      agreement_id: trimText(context?.agreement?.id, 120) || null,
      recipient: recipient ? redactEmail(recipient) : null,
      actor: redactEmail(actorEmail),
      code: trimText(error?.code, 80) || 'agreement_link_resend_failed',
      status: Number(error?.status) || 500,
      detail: scrubActionDetail(error?.detail || error?.message || 'Agreement link resend failed.')
    });
    throw error;
  }
}

async function buildAdminPublicPurchasesPayload({ db, query = {}, now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    const error = new Error('Database client is required.');
    error.code = 'database_client_required';
    error.status = 500;
    throw error;
  }

  const filters = parseFilters(query, now);
  const warnings = [];
  const intentRows = await readIntentRows(db, filters);
  const agreementIds = cleanIdList(intentRows.map((row) => row?.agreement_id));
  const agreementRows = await readAgreementRows(db, agreementIds);
  const agreementsById = mapById(agreementRows);
  const clientIds = cleanIdList([
    ...intentRows.map((row) => row?.client_id),
    ...agreementRows.map((row) => row?.client_id)
  ]);
  const clientRows = await readClientRows(db, clientIds);
  const clientsById = mapById(clientRows);
  const memberRows = await readMemberRows(db, clientIds);
  const membersByClientId = buildMemberMap(memberRows);
  const emailRows = await readWelcomeEmailRows(db, intentRows.map((row) => row?.buyer_email), warnings);
  const emailSummaries = buildEmailSummaryMap(emailRows);
  const creditRows = await readCreditRows(db, intentRows.map((row) => row?.id), warnings);
  const creditSummaries = buildCreditMap(creditRows);

  const allItems = intentRows.map((intent) => {
    const agreement = agreementsById.get(trimText(intent?.agreement_id, 120)) || null;
    const client = clientsById.get(trimText(intent?.client_id || agreement?.client_id, 120)) || null;
    const members = membersByClientId.get(trimText(intent?.client_id || agreement?.client_id || client?.id, 120)) || [];
    const member = chooseBuyerMember(members, intent?.buyer_email || agreement?.admin_email || client?.email);
    const emailSummary =
      emailSummaries.byIntentId.get(trimText(intent?.id, 120)) ||
      emailSummaries.byEmail.get(lowerText(intent?.buyer_email, 254)) ||
      null;
    const firstRoleCredit = creditSummaries.byIntentId.get(trimText(intent?.id, 120)) || null;
    return sanitizePurchaseItem({ intent, agreement, client, member, emailSummary, firstRoleCredit });
  }).filter((item) => {
    if (filters.membership === 'enterprise') return item.membership.key === 'enterprise';
    if (filters.status && item.status.key !== filters.status) return false;
    if (filters.search && !matchesSearch(item, filters.search)) return false;
    return true;
  });

  const paged = paginate(allItems, filters.page, filters.limit);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    request_id: requestId || null,
    filters: {
      date_range: filters.date_range,
      days: filters.days,
      date_from: filters.date_from,
      date_to: filters.date_to,
      date_from_display: filters.date_from_display,
      date_to_display: filters.date_to_display,
      status: filters.status || 'all',
      membership: filters.membership || 'all',
      billing_cadence: filters.billing_cadence || 'all',
      channel: filters.channel || 'all',
      representative: filters.representative || '',
      search: filters.search || ''
    },
    summary: buildSummary(allItems),
    warnings,
    purchases: {
      items: paged.items,
      pagination: {
        page: paged.page,
        limit: paged.limit,
        total: paged.total,
        total_pages: paged.total_pages,
        returned: paged.returned,
        has_more: paged.has_more
      }
    }
  };
}

function safePublicPurchasesErrorBody(error, requestId = null) {
  return {
    error: 'public_purchases_read_failed',
    code: trimText(error?.code, 80) || 'public_purchases_read_failed',
    detail: trimText(error?.message, 300) || 'Could not load public purchases.',
    request_id: requestId || null
  };
}

function scrubActionDetail(value) {
  return trimText(value, 500)
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-link]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk_[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/[A-Fa-f0-9]{64,}/g, '[redacted-token]');
}

function safePublicPurchaseActionErrorBody(error, requestId = null) {
  return {
    error: trimText(error?.code, 80) || 'public_purchase_recovery_failed',
    code: trimText(error?.code, 80) || 'public_purchase_recovery_failed',
    detail: scrubActionDetail(error?.detail || error?.message || 'Public purchase recovery action failed.'),
    request_id: requestId || null
  };
}

module.exports = {
  buildAdminPublicPurchasesPayload,
  mapPublicPurchaseStatus,
  parseFilters,
  resendPublicPurchaseAgreementLink,
  resendPublicPurchaseCheckoutLink,
  resendPublicPurchaseSetupEmail,
  resendPublicPurchaseWelcomeEmail,
  safePublicPurchaseActionErrorBody,
  safePublicPurchasesErrorBody
};

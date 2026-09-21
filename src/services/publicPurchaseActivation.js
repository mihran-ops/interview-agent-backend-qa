'use strict';

const { supabaseAdmin } = require('../clients/supabase');
const { requireParentClient } = require('./clientBillingScope');
const {
  buildAlphaScreenPlanSettingsPayload,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('./alphaScreenPackages');
const { defaultBillingModelForPlanTier } = require('./billingModel');
const { ensureUserAndSendRecovery, redactEmail } = require('./recoveryHelper');
const { sendMemberRecoveryEmail, sendAlphaScreenWelcomeEmail } = require('../clients/sendgrid');
const { buildClientPwResetUrl } = require('../config/urlConfig');
const { enqueueSalesWonDelivery } = require('./salesIntegrations');

const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const PRIVILEGED_MEMBER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin']);
const WELCOME_EMAIL_CATEGORY = 'public_purchase_welcome';
const NON_RETRYABLE_WELCOME_EMAIL_STATUSES = new Set(['sent', 'sending']);

function pickId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function addMonthsToIso(isoValue, monthsToAdd) {
  if (!isoValue) return null;
  const d = new Date(isoValue);
  if (!Number.isFinite(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(monthsToAdd || 0));
  return d.toISOString();
}

function cleanText(value) {
  return String(value || '').trim();
}

function lowerEmail(value) {
  return cleanText(value).toLowerCase();
}

function getTemplateSnapshot(agreement) {
  return agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : {};
}

function getPackageSnapshot({ agreement, intent }) {
  const agreementSnapshot = getTemplateSnapshot(agreement);
  const snapshot = agreementSnapshot.package_snapshot && typeof agreementSnapshot.package_snapshot === 'object'
    ? agreementSnapshot.package_snapshot
    : null;
  if (snapshot) return snapshot;
  return intent?.package_snapshot && typeof intent.package_snapshot === 'object'
    ? intent.package_snapshot
    : null;
}

function getFirstRolePrepaySnapshot(packageSnapshot) {
  return packageSnapshot?.first_role_prepay && typeof packageSnapshot.first_role_prepay === 'object'
    ? packageSnapshot.first_role_prepay
    : null;
}

function isDuplicateRecordError(error) {
  return String(error?.code || '').trim() === '23505' ||
    String(error?.message || '').toLowerCase().includes('duplicate key');
}

function publicPurchaseIntentIdFromAgreement(agreement) {
  const snapshot = getTemplateSnapshot(agreement);
  return cleanText(snapshot?.purchase_intent?.id || '');
}

function buildBuyerName(intent, agreement) {
  const first = cleanText(intent?.buyer_first_name);
  const last = cleanText(intent?.buyer_last_name);
  return `${first} ${last}`.trim() ||
    cleanText(agreement?.primary_admin_name) ||
    cleanText(intent?.buyer_email || agreement?.admin_email);
}

function buildClientName(intent, agreement) {
  return cleanText(intent?.company_legal_name) ||
    cleanText(agreement?.client_legal_name) ||
    cleanText(intent?.company_dba) ||
    'alphaScreen client';
}

function isPublicPurchaseAgreement(agreement, intent) {
  const snapshot = getTemplateSnapshot(agreement);
  return Boolean(
    intent?.id ||
    publicPurchaseIntentIdFromAgreement(agreement) ||
    ['public_purchase_intent', 'sales_assisted'].includes(cleanText(snapshot?.source).toLowerCase())
  );
}

function isLiveClientActivationState(client) {
  const billingStatus = cleanText(client?.billing_status).toLowerCase();
  const subscriptionStatus = cleanText(client?.subscription_status).toLowerCase();
  return billingStatus === 'active' && (!subscriptionStatus || LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus));
}

function buildWelcomeLedgerKey({ agreement, intent, clientId, email }) {
  const stableId = cleanText(intent?.id) || cleanText(agreement?.id) || cleanText(clientId);
  const normalizedEmail = lowerEmail(email);
  return `public_purchase_welcome:${stableId}:${normalizedEmail}`.slice(0, 240);
}

function welcomeLedgerPayload({ agreement, intent, clientId, email, ledgerKey, nowIso }) {
  const purchaseIntentId = cleanText(intent?.id) || null;
  const agreementId = cleanText(agreement?.id) || null;
  const safeClientId = cleanText(clientId) || null;
  return {
    event_type: 'outbound_public_purchase_welcome',
    event_at: nowIso,
    email,
    sg_event_id: ledgerKey,
    category: WELCOME_EMAIL_CATEGORY,
    email_category: WELCOME_EMAIL_CATEGORY,
    custom_args: {
      email_category: WELCOME_EMAIL_CATEGORY,
      client_id: safeClientId,
      agreement_id: agreementId,
      purchase_intent_id: purchaseIntentId
    },
    status: 'sending',
    attempt: 1,
    subject: 'Welcome to alphaScreen',
    raw_payload: {
      source: 'public_purchase_activation',
      client_id: safeClientId,
      agreement_id: agreementId,
      purchase_intent_id: purchaseIntentId
    },
    is_problem: false,
    is_time_sensitive: false
  };
}

async function readWelcomeLedger(db, ledgerKey) {
  const { data, error } = await db
    .from('email_delivery_events')
    .select('id,status,sg_event_id,attempt')
    .eq('sg_event_id', ledgerKey)
    .maybeSingle();
  if (error) {
    const err = new Error(error.message || 'Welcome email ledger lookup failed');
    err.code = error.code || 'welcome_email_ledger_lookup_failed';
    throw err;
  }
  return data || null;
}

async function reserveWelcomeEmailSend({ db, agreement, intent, clientId, email, nowIso }) {
  const ledgerKey = buildWelcomeLedgerKey({ agreement, intent, clientId, email });
  const existing = await readWelcomeLedger(db, ledgerKey);
  if (existing?.id || existing?.sg_event_id) {
    const existingStatus = cleanText(existing.status).toLowerCase();
    if (NON_RETRYABLE_WELCOME_EMAIL_STATUSES.has(existingStatus)) {
      return {
        reserved: false,
        ledgerKey,
        status: existingStatus || 'already_recorded'
      };
    }

    const attempt = Math.max(0, Number(existing.attempt || 0)) + 1;
    const { error } = await db
      .from('email_delivery_events')
      .update({
        status: 'sending',
        response: null,
        is_problem: false,
        event_at: nowIso,
        attempt
      })
      .eq('sg_event_id', ledgerKey);
    if (error) {
      const err = new Error(error.message || 'Welcome email ledger retry reservation failed');
      err.code = error.code || 'welcome_email_ledger_retry_failed';
      throw err;
    }
    return {
      reserved: true,
      ledgerKey,
      status: 'retrying'
    };
  }

  const { error } = await db
    .from('email_delivery_events')
    .insert(welcomeLedgerPayload({ agreement, intent, clientId, email, ledgerKey, nowIso }));
  if (error) {
    const duplicate = String(error.code || '') === '23505' || /duplicate/i.test(String(error.message || ''));
    if (duplicate) {
      return { reserved: false, ledgerKey, status: 'already_recorded' };
    }
    const err = new Error(error.message || 'Welcome email ledger reservation failed');
    err.code = error.code || 'welcome_email_ledger_reservation_failed';
    throw err;
  }

  return { reserved: true, ledgerKey, status: 'reserved' };
}

async function updateWelcomeEmailLedger({ db, ledgerKey, status, response = '', isProblem = false }) {
  const payload = {
    status,
    response: cleanText(response).slice(0, 500) || null,
    is_problem: isProblem === true,
    event_at: new Date().toISOString()
  };
  const { error } = await db
    .from('email_delivery_events')
    .update(payload)
    .eq('sg_event_id', ledgerKey);
  if (error) {
    const err = new Error(error.message || 'Welcome email ledger update failed');
    err.code = error.code || 'welcome_email_ledger_update_failed';
    throw err;
  }
}

async function sendWelcomeEmailOnce({
  db,
  agreement,
  intent,
  clientId,
  buyerEmail,
  buyerName,
  sendWelcomeEmail,
  logger,
  nowIso
}) {
  const reservation = await reserveWelcomeEmailSend({
    db,
    agreement,
    intent,
    clientId,
    email: buyerEmail,
    nowIso
  });

  if (!reservation.reserved) {
    logger.info?.('[public-purchase-activation] welcome_email_skipped', {
      email: redactEmail(buyerEmail),
      client_id: clientId,
      agreement_id: cleanText(agreement?.id) || null,
      purchase_intent_id: cleanText(intent?.id) || null,
      status: reservation.status
    });
    return reservation.status === 'sent' ? 'already_sent' : 'already_recorded';
  }

  try {
    const firstName = cleanText(intent?.buyer_first_name) || cleanText(buyerName).split(/\s+/).filter(Boolean)[0] || '';
    logger.info?.('[public-purchase-activation] welcome_email_attempting', {
      email: redactEmail(buyerEmail),
      client_id: clientId,
      agreement_id: cleanText(agreement?.id) || null,
      purchase_intent_id: cleanText(intent?.id) || null,
      reservation_status: reservation.status
    });
    const emailResult = await sendWelcomeEmail(buyerEmail, {
      firstName,
      recipientName: buyerName,
      clientId,
      agreementId: agreement?.id,
      purchaseIntentId: intent?.id
    });
    const status = emailResult?.statusCode === 202
      ? 'sent'
      : emailResult?.skipped
        ? 'skipped'
        : 'send_failed';
    await updateWelcomeEmailLedger({
      db,
      ledgerKey: reservation.ledgerKey,
      status,
      response: emailResult?.skipped ? 'email_skipped' : `status:${emailResult?.statusCode || 0}`,
      isProblem: status === 'send_failed'
    });
    if (status !== 'sent') {
      logger.warn?.('[public-purchase-activation] welcome_email_not_sent', {
        email: redactEmail(buyerEmail),
        status
      });
    } else {
      logger.info?.('[public-purchase-activation] welcome_email_sent', {
        email: redactEmail(buyerEmail),
        client_id: clientId,
        agreement_id: cleanText(agreement?.id) || null,
        purchase_intent_id: cleanText(intent?.id) || null
      });
    }
    return status;
  } catch (error) {
    try {
      await updateWelcomeEmailLedger({
        db,
        ledgerKey: reservation.ledgerKey,
        status: 'send_failed',
        response: error?.message || 'send_failed',
        isProblem: true
      });
    } catch (ledgerError) {
      logger.warn?.('[public-purchase-activation] welcome_email_ledger_update_failed', {
        email: redactEmail(buyerEmail),
        error: ledgerError?.message || ledgerError
      });
    }
    logger.error?.('[public-purchase-activation] welcome_email_failed', {
      email: redactEmail(buyerEmail),
      error: error?.message || error
    });
    return 'send_failed';
  }
}

function resolvePlanSelection({ agreement, intent, packageSnapshot, fallbackPlanTier, fallbackBillingInterval }) {
  const planKey = normalizeAlphaScreenPlanKey(
    packageSnapshot?.plan_key ||
    intent?.selected_plan_key ||
    agreement?.membership_tier ||
    fallbackPlanTier
  );
  const billingInterval = normalizeBillingInterval(
    packageSnapshot?.billing_cadence ||
    intent?.selected_billing_cadence ||
    agreement?.billing_option ||
    fallbackBillingInterval
  );

  if (!['basic', 'pro'].includes(planKey)) {
    const err = new Error('Public purchase agreement has an invalid membership key.');
    err.code = 'invalid_public_purchase_plan_key';
    throw err;
  }
  if (!billingInterval) {
    const err = new Error('Public purchase agreement has an invalid billing cadence.');
    err.code = 'invalid_public_purchase_billing_interval';
    throw err;
  }

  return { planKey, billingInterval };
}

async function loadPublicPurchaseIntent(db, agreement) {
  const agreementId = cleanText(agreement?.id);
  const snapshotIntentId = publicPurchaseIntentIdFromAgreement(agreement);
  if (snapshotIntentId) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,channel,term_start_basis,canceled_at,activation_claimed_at,activation_claim_key,expires_at,created_at,updated_at')
      .eq('id', snapshotIntentId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
    if (data) return data;
  }

  if (!agreementId) return null;
  const { data, error } = await db
    .from('public_purchase_intents')
    .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,channel,term_start_basis,canceled_at,activation_claimed_at,activation_claim_key,expires_at,created_at,updated_at')
    .eq('agreement_id', agreementId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
  return data || null;
}

async function createFirstRolePrepayCredit({ db, agreement, intent, clientId, billingClientId, packageSnapshot, planKey, checkoutSessionId, nowIso, logger }) {
  const firstRolePrepay = getFirstRolePrepaySnapshot(packageSnapshot);
  if (!firstRolePrepay?.selected) return 'not_selected';
  const purchaseIntentId = cleanText(intent?.id) || null;
  const agreementId = cleanText(agreement?.id) || null;
  const safeBillingClientId = cleanText(billingClientId || clientId);
  if (!safeBillingClientId) return 'billing_client_missing';

  const payload = {
    billing_client_id: safeBillingClientId,
    source_client_id: cleanText(clientId) || null,
    source_public_purchase_intent_id: purchaseIntentId,
    source_membership_agreement_id: agreementId,
    source_stripe_checkout_session_id: cleanText(checkoutSessionId || intent?.stripe_checkout_session_id || agreement?.checkout_session_id) || null,
    credit_type: cleanText(firstRolePrepay.credit_type) || 'first_role_prepay',
    membership_key: planKey,
    normal_role_fee_cents: Number(firstRolePrepay.normal_role_fee_cents),
    discounted_credit_amount_cents: Number(firstRolePrepay.discounted_credit_amount_cents),
    discount_percent: Number(firstRolePrepay.discount_percent),
    status: 'unused',
    metadata: {
      source: 'public_purchase_activation',
      non_refundable: firstRolePrepay.non_refundable === true,
      expires: firstRolePrepay.expires === true,
      purchase_intent_id: purchaseIntentId,
      membership_agreement_id: agreementId
    },
    created_at: nowIso,
    updated_at: nowIso
  };

  const { error } = await db
    .from('client_role_credits')
    .insert(payload);
  if (!error) return 'created';
  if (isDuplicateRecordError(error)) return 'already_created';

  logger.error?.('[public-purchase-activation] first_role_prepay_credit_create_failed', {
    agreement_id: agreementId,
    purchase_intent_id: purchaseIntentId,
    client_id: cleanText(clientId) || null,
    billing_client_id: safeBillingClientId,
    error: error.message || error,
    code: error.code || null
  });
  throw new Error(error.message || 'First-role prepay credit creation failed');
}

async function ensureLinkedClient({ db, agreement, intent, planKey, billingInterval, fallbackClientId }) {
  const nowIso = new Date().toISOString();
  let clientId = cleanText(agreement?.client_id || intent?.client_id || fallbackClientId);
  if (!clientId) {
    const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
    const buyerName = buildBuyerName(intent, agreement);
    const { data: client, error: clientErr } = await db
      .from('clients')
      .insert({
        name: buildClientName(intent, agreement),
        email: buyerEmail,
        client_admin_name: buyerName || null,
        plan_tier: planKey,
        billing_interval: billingInterval,
        billing_status: 'inactive',
        subscription_status: 'incomplete',
        auto_renew: false
      })
      .select('id')
      .single();
    if (clientErr || !client?.id) throw new Error(clientErr?.message || 'Could not create public purchase client.');
    clientId = cleanText(client.id);
  }

  if (cleanText(agreement?.client_id) !== clientId) {
    const { error } = await db
      .from('membership_agreements')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', agreement.id);
    if (error) throw new Error(error.message || 'Agreement client link failed');
    agreement.client_id = clientId;
  }

  if (intent?.id && cleanText(intent.client_id) !== clientId) {
    const { error } = await db
      .from('public_purchase_intents')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', intent.id);
    if (error) throw new Error(error.message || 'Public purchase intent client link failed');
    intent.client_id = clientId;
  }

  return clientId;
}

function buildClientActivationPayload({ agreement, subscription, planKey, billingInterval, fallbackCustomerId, fallbackSubscriptionId }) {
  const status = cleanText(subscription?.status).toLowerCase();
  const isLive = LIVE_SUBSCRIPTION_STATUSES.has(status);
  const cancelAtTermEnd = subscription?.cancel_at_period_end === true;
  const currentTermEnd = toIsoFromUnixSeconds(
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null
  );
  const contractStartAt = toIsoFromUnixSeconds(subscription?.start_date) || new Date().toISOString();
  const contractEndAt = addMonthsToIso(contractStartAt, 12);
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const stripeBillingInterval = normalizeBillingInterval(intervalRaw);

  return {
    stripe_customer_id: pickId(subscription?.customer) || cleanText(fallbackCustomerId) || null,
    stripe_subscription_id: pickId(subscription?.id) || cleanText(fallbackSubscriptionId) || null,
    subscription_status: isLive ? status : 'active',
    billing_status: 'active',
    billing_interval: stripeBillingInterval || billingInterval,
    plan_tier: planKey,
    current_term_end: currentTermEnd || contractEndAt,
    cancel_at_term_end: isLive ? cancelAtTermEnd : false,
    auto_renew: typeof agreement?.auto_renew === 'boolean' ? agreement.auto_renew : (isLive ? !cancelAtTermEnd : true),
    cancel_effective_at: null,
    contract_start_at: contractStartAt,
    contract_end_at: contractEndAt
  };
}

async function findAuthUserByEmail(authAdmin, email, logger = console) {
  const normalizedEmail = cleanText(email);
  const emailLower = normalizedEmail.toLowerCase();
  if (!authAdmin?.listUsers || !emailLower) return null;
  try {
    const { data, error } = await authAdmin.listUsers({ email: normalizedEmail });
    if (error) {
      logger.error?.('[public-purchase-activation] list_users_failed', {
        email: redactEmail(normalizedEmail),
        error: error.message || error
      });
      return null;
    }
    return (data?.users || []).find((user) => lowerEmail(user?.email) === emailLower) || null;
  } catch (error) {
    logger.error?.('[public-purchase-activation] list_users_exception', {
      email: redactEmail(normalizedEmail),
      error: error?.message || error
    });
    return null;
  }
}

async function findAuthUserById(authAdmin, userId, logger = console) {
  const normalizedUserId = cleanText(userId);
  if (!authAdmin?.getUserById || !normalizedUserId) return null;
  try {
    const { data, error } = await authAdmin.getUserById(normalizedUserId);
    if (error) {
      logger.error?.('[public-purchase-activation] get_user_by_id_failed', {
        user_id: normalizedUserId,
        error: error.message || error
      });
      return null;
    }
    return data?.user || null;
  } catch (error) {
    logger.error?.('[public-purchase-activation] get_user_by_id_exception', {
      user_id: normalizedUserId,
      error: error?.message || error
    });
    return null;
  }
}

async function generatePasswordSetupUrl({ authAdmin, email, clientId, requestId, logger = console } = {}) {
  const normalizedEmail = lowerEmail(email);
  if (!authAdmin?.generateLink || !normalizedEmail) return '';

  const redirectTo = buildClientPwResetUrl({
    origin: 'client',
    checkout: 'success',
    client_id: cleanText(clientId)
  });

  try {
    const link = await authAdmin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo }
    });
    if (link?.error) throw link.error;
    return cleanText(link?.data?.action_link || link?.data?.properties?.action_link);
  } catch (error) {
    logger.warn?.('[public-purchase-activation] setup_link_generation_failed', {
      request_id: requestId || null,
      email: redactEmail(normalizedEmail),
      client_id: cleanText(clientId) || null,
      error: error?.message || error,
      code: error?.code || null
    });
    return '';
  }
}

async function loadExistingMembership(db, clientId, email, userId) {
  const { data, error } = await db
    .from('client_members')
    .select('client_id,user_id,email,name,role')
    .eq('client_id', clientId);
  if (error) throw new Error(error.message || 'Client member lookup failed');

  const emailLower = lowerEmail(email);
  const normalizedUserId = cleanText(userId);
  return (data || []).find((row) => {
    const rowEmail = lowerEmail(row?.email);
    const rowUserId = cleanText(row?.user_id);
    return (emailLower && rowEmail === emailLower) || (normalizedUserId && rowUserId === normalizedUserId);
  }) || null;
}

function managerRoleFor(existingRole) {
  const role = cleanText(existingRole).toLowerCase();
  return PRIVILEGED_MEMBER_ROLES.has(role) ? role : 'manager';
}

async function upsertBuyerMembership({ db, clientId, email, name, userId }) {
  const existing = await loadExistingMembership(db, clientId, email, userId);
  const role = managerRoleFor(existing?.role);
  if (!existing) {
    const payload = {
      client_id: clientId,
      email,
      name,
      role,
      user_id: userId
    };
    try {
      const { error } = await db.from('client_members').insert(payload);
      if (error) throw error;
      return { status: 'created', role };
    } catch (error) {
      const duplicate = String(error?.code || '') === '23505' || /duplicate/i.test(String(error?.message || ''));
      if (!duplicate) throw new Error(error?.message || 'Client member insert failed');
      const duplicateRow = await loadExistingMembership(db, clientId, email, userId);
      if (!duplicateRow) throw new Error(error?.message || 'Client member insert failed');
      return upsertBuyerMembership({ db, clientId, email, name, userId });
    }
  }

  const updatePayload = {};
  if (managerRoleFor(existing.role) !== cleanText(existing.role).toLowerCase()) updatePayload.role = role;
  if (!cleanText(existing.name) && name) updatePayload.name = name;
  if (!lowerEmail(existing.email) && email) updatePayload.email = email;
  if (userId && cleanText(existing.user_id) !== userId) updatePayload.user_id = userId;

  if (!Object.keys(updatePayload).length) return { status: 'existing', role };

  let query = db.from('client_members').update(updatePayload).eq('client_id', clientId);
  if (cleanText(existing.email)) query = query.eq('email', cleanText(existing.email));
  else query = query.eq('user_id', cleanText(existing.user_id));
  const { error } = await query;
  if (error) throw new Error(error.message || 'Client member update failed');
  return { status: 'updated', role };
}

async function ensureBuyerAccountSetup({
  db,
  authAdmin,
  clientId,
  agreement,
  intent,
  requestId,
  logger,
  ensureRecovery,
  sendRecoveryEmail
}) {
  const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
  if (!buyerEmail) {
    const err = new Error('Public purchase buyer email is missing.');
    err.code = 'public_purchase_buyer_email_missing';
    throw err;
  }
  const buyerName = buildBuyerName(intent, agreement) || buyerEmail;
  const redirectTo = buildClientPwResetUrl({
    origin: 'public_purchase',
    checkout: 'success',
    client_id: clientId
  });

  const existingAuthUser = await findAuthUserByEmail(authAdmin, buyerEmail, logger);
  let authStatus = existingAuthUser ? 'existing_user' : 'created_user';
  let setupEmailStatus = existingAuthUser ? 'not_sent_existing_user' : 'not_sent';
  let userId = cleanText(existingAuthUser?.id);

  if (!userId) {
    const ensured = await ensureRecovery({
      email: buyerEmail,
      redirectTo,
      request_id: requestId,
      loggerPrefix: '[public-purchase-activation]'
    });
    userId = cleanText(ensured?.userId);
    authStatus = cleanText(ensured?.method) || 'created_user';

    const actionLink = cleanText(ensured?.actionLink);
    if (actionLink) {
      try {
        const emailResult = await sendRecoveryEmail(buyerEmail, actionLink, buyerName);
        setupEmailStatus = emailResult?.statusCode === 202
          ? 'sent'
          : emailResult?.skipped
            ? 'skipped'
            : 'send_failed';
        if (setupEmailStatus !== 'sent') {
          logger.warn?.('[public-purchase-activation] setup_email_not_sent', {
            email: redactEmail(buyerEmail),
            status: setupEmailStatus
          });
        }
      } catch (error) {
        setupEmailStatus = 'send_failed';
        logger.error?.('[public-purchase-activation] setup_email_failed', {
          email: redactEmail(buyerEmail),
          error: error?.message || error
        });
      }
    } else {
      setupEmailStatus = 'link_unavailable';
    }
  }

  if (!userId) {
    const err = new Error('Could not create or locate user for public purchase buyer.');
    err.code = 'public_purchase_auth_user_missing';
    throw err;
  }

  const membership = await upsertBuyerMembership({
    db,
    clientId,
    email: buyerEmail,
    name: buyerName,
    userId
  });

  return {
    auth_status: authStatus,
    user_id: userId,
    member_status: membership.status,
    member_role: membership.role,
    setup_email_status: setupEmailStatus
  };
}

async function activatePublicPurchaseAgreementCheckout(options = {}) {
  const db = options.db || supabaseAdmin;
  const authAdmin = options.authAdmin || supabaseAdmin.auth?.admin;
  const logger = options.logger || console;
  const requireParent = options.requireParentClient || requireParentClient;
  const ensureRecovery = options.ensureRecovery || ensureUserAndSendRecovery;
  const sendRecoveryEmail = options.sendRecoveryEmail || sendMemberRecoveryEmail;
  const sendWelcomeEmail = options.sendWelcomeEmail || sendAlphaScreenWelcomeEmail;
  const agreementId = cleanText(options.agreementId);
  if (!agreementId) return { ok: false, status: 'agreement_missing' };

  const paidAt = cleanText(options.paidAt) || new Date().toISOString();
  const checkoutSessionId = cleanText(options.checkoutSessionId);

  const { data: agreement, error: agreementErr } = await db
    .from('membership_agreements')
    .select('id,client_id,status,is_current,checkout_status,checkout_session_id,checkout_paid_at,primary_admin_name,admin_email,client_legal_name,dba_trade_name,membership_tier,billing_option,auto_renew,template_snapshot,superseded_by_agreement_id')
    .eq('id', agreementId)
    .maybeSingle();
  if (agreementErr) throw new Error(agreementErr.message || 'Agreement lookup failed');
  if (!agreement) return { ok: false, status: 'agreement_not_found' };

  const intent = await loadPublicPurchaseIntent(db, agreement);
  if (cleanText(agreement.superseded_by_agreement_id) || (intent?.agreement_id && cleanText(intent.agreement_id) !== agreementId)) {
    logger.warn?.('[public-purchase-activation] superseded_agreement_payment_requires_review', {
      agreement_id: agreementId,
      purchase_intent_id: intent?.id || null,
      checkout_session_id: checkoutSessionId || null
    });
    return { ok: false, status: 'agreement_superseded', purchase_intent_id: intent?.id || null };
  }
  if (cleanText(intent?.status).toLowerCase() === 'canceled' || cleanText(intent?.canceled_at)) {
    logger.warn?.('[public-purchase-activation] canceled_intent_payment_requires_review', {
      agreement_id: agreementId,
      purchase_intent_id: intent?.id || null,
      checkout_session_id: checkoutSessionId || null
    });
    return { ok: false, status: 'purchase_canceled', purchase_intent_id: intent?.id || null };
  }
  const packageSnapshot = getPackageSnapshot({ agreement, intent });
  const { planKey, billingInterval } = resolvePlanSelection({
    agreement,
    intent,
    packageSnapshot,
    fallbackPlanTier: options.fallbackPlanTier,
    fallbackBillingInterval: options.fallbackBillingInterval
  });

  const clientId = await ensureLinkedClient({
    db,
    agreement,
    intent,
    planKey,
    billingInterval,
    fallbackClientId: options.fallbackClientId
  });
  const { data: existingClientState, error: existingClientStateErr } = await db
    .from('clients')
    .select('id,billing_status,subscription_status')
    .eq('id', clientId)
    .maybeSingle();
  if (existingClientStateErr) throw new Error(existingClientStateErr.message || 'Client activation state lookup failed');
  const agreementAlreadyPaid = cleanText(agreement.checkout_status).toLowerCase() === 'paid';
  const clientAlreadyActive = isLiveClientActivationState(existingClientState);
  const parentGuard = await requireParent(db, clientId, {
    route: 'public_purchase_webhook_activation',
    agreement_id: agreementId,
    client_id: clientId
  });
  if (!parentGuard?.ok) {
    const body = parentGuard?.body || {};
    const err = new Error(body.detail || body.error || 'Client billing scope check failed');
    err.code = body.code || body.error || 'CLIENT_BILLING_SCOPE_CHECK_FAILED';
    throw err;
  }
  const billingClientId = cleanText(parentGuard.clientId || clientId) || clientId;

  const agreementPaidPayload = {
    checkout_status: 'paid',
    checkout_paid_at: paidAt
  };
  if (cleanText(intent?.term_start_basis).toLowerCase() === 'successful_payment') {
    const paidDate = new Date(paidAt);
    if (!Number.isNaN(paidDate.getTime())) {
      const initialTermStart = paidDate.toISOString().slice(0, 10);
      const renewal = new Date(Date.UTC(
        paidDate.getUTCFullYear() + 1,
        paidDate.getUTCMonth(),
        paidDate.getUTCDate()
      ));
      agreementPaidPayload.initial_term_start = initialTermStart;
      agreementPaidPayload.initial_renewal_date = renewal.toISOString().slice(0, 10);
    }
  }
  if (checkoutSessionId) agreementPaidPayload.checkout_session_id = checkoutSessionId;
  const { error: agreementUpdateErr } = await db
    .from('membership_agreements')
    .update(agreementPaidPayload)
    .eq('id', agreementId);
  if (agreementUpdateErr) throw new Error(agreementUpdateErr.message || 'Agreement checkout status update failed');

  if (intent?.id) {
    const intentPayload = {
      status: 'completed',
      client_id: clientId,
      activated_at: paidAt,
      updated_at: paidAt
    };
    if (checkoutSessionId) intentPayload.stripe_checkout_session_id = checkoutSessionId;
    let intentCompletionQuery = db
      .from('public_purchase_intents')
      .update(intentPayload)
      .eq('id', intent.id)
      .neq('status', 'canceled')
      .is('canceled_at', null);
    if (cleanText(intent.activation_claim_key)) {
      intentCompletionQuery = intentCompletionQuery.eq('activation_claim_key', intent.activation_claim_key);
    }
    const { data: completedIntent, error: intentUpdateErr } = await intentCompletionQuery
      .select('id')
      .maybeSingle();
    if (intentUpdateErr) {
      logger.error?.('[public-purchase-activation] intent_completion_failed', {
        agreement_id: agreementId,
        purchase_intent_id: intent.id,
        error: intentUpdateErr.message,
        code: intentUpdateErr.code || null
      });
    }
    if (!intentUpdateErr && !completedIntent) {
      const err = new Error('Purchase activation lost its cancellation guard.');
      err.code = 'public_purchase_activation_guard_lost';
      throw err;
    }
  }

  const clientActivationPayload = buildClientActivationPayload({
    agreement,
    subscription: options.subscription,
    planKey,
    billingInterval,
    fallbackCustomerId: options.fallbackCustomerId,
    fallbackSubscriptionId: options.fallbackSubscriptionId
  });
  const { error: clientUpdateErr } = await db
    .from('clients')
    .update(clientActivationPayload)
    .eq('id', clientId);
  if (clientUpdateErr) throw new Error(clientUpdateErr.message || 'Client activation update failed');

  const planSettingsPayload = buildAlphaScreenPlanSettingsPayload({
    clientId,
    planKey,
    billingInterval
  });
  // The tier decides the billing model for a newly activated client.
  const planSettingsUpsert = planSettingsPayload
    ? { ...planSettingsPayload, billing_model: defaultBillingModelForPlanTier(planSettingsPayload.plan_tier) }
    : planSettingsPayload;
  const { error: settingsErr } = await db
    .from('client_plan_settings')
    .upsert(planSettingsUpsert, { onConflict: 'client_id' });
  if (settingsErr) throw new Error(settingsErr.message || 'Client plan settings upsert failed');

  const firstRoleCreditStatus = await createFirstRolePrepayCredit({
    db,
    agreement,
    intent,
    clientId,
    billingClientId,
    packageSnapshot,
    planKey,
    checkoutSessionId,
    nowIso: paidAt,
    logger
  });

  const setup = await ensureBuyerAccountSetup({
    db,
    authAdmin,
    clientId,
    agreement,
    intent,
    requestId: options.requestId || null,
    logger,
    ensureRecovery,
    sendRecoveryEmail
  });
  let welcomeEmailStatus = 'not_sent';
  const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
  const buyerName = buildBuyerName(intent, agreement) || buyerEmail;
  const publicPurchaseWelcomeEligible = Boolean(isPublicPurchaseAgreement(agreement, intent) && buyerEmail);
  logger.info?.('[public-purchase-activation] welcome_email_decision', {
    eligible: publicPurchaseWelcomeEligible,
    reason: publicPurchaseWelcomeEligible ? 'public_purchase_activation' : buyerEmail ? 'not_public_purchase' : 'missing_buyer_email',
    email: redactEmail(buyerEmail),
    client_id: clientId,
    agreement_id: agreementId,
    purchase_intent_id: cleanText(intent?.id) || null,
    agreement_already_paid: agreementAlreadyPaid,
    client_already_active: clientAlreadyActive
  });
  const shouldSendWelcome = publicPurchaseWelcomeEligible;
  if (shouldSendWelcome) {
    try {
      welcomeEmailStatus = await sendWelcomeEmailOnce({
        db,
        agreement,
        intent,
        clientId,
        buyerEmail,
        buyerName,
        sendWelcomeEmail,
        logger,
        nowIso: paidAt
      });
    } catch (error) {
      welcomeEmailStatus = 'ledger_unavailable';
      logger.error?.('[public-purchase-activation] welcome_email_ledger_failed', {
        email: redactEmail(buyerEmail),
        error: error?.message || error,
        code: error?.code || null
      });
    }
  } else {
    welcomeEmailStatus = buyerEmail ? 'not_sent_not_public_purchase' : 'not_sent_missing_buyer_email';
  }

  let salesWonDeliveryStatus = 'not_applicable';
  if (cleanText(intent?.channel).toLowerCase() === 'sales_assisted' && intent?.id) {
    try {
      const delivery = await enqueueSalesWonDelivery(intent.id, { db });
      salesWonDeliveryStatus = delivery.status;
    } catch (error) {
      salesWonDeliveryStatus = 'enqueue_failed';
      logger.error?.('[public-purchase-activation] sales_won_enqueue_failed', {
        purchase_intent_id: intent.id,
        agreement_id: agreementId,
        error: error?.message || error
      });
    }
  }

  return {
    ok: true,
    agreement_id: agreementId,
    purchase_intent_id: intent?.id || null,
    client_id: clientId,
    plan_key: planKey,
    billing_interval: billingInterval,
    plan_settings: planSettingsPayload,
    member_status: setup.member_status,
    member_role: setup.member_role,
    auth_status: setup.auth_status,
    setup_email_status: setup.setup_email_status,
    welcome_email_status: welcomeEmailStatus,
    first_role_credit_status: firstRoleCreditStatus,
    sales_won_delivery_status: salesWonDeliveryStatus
  };
}

async function resolvePublicCheckoutReturnState(options = {}) {
  const db = options.db || supabaseAdmin;
  const authAdmin = options.authAdmin || supabaseAdmin.auth?.admin;
  const logger = options.logger || console;
  const requestId = options.requestId || null;
  const sessionId = cleanText(options.sessionId);
  const fallbackClientId = cleanText(options.fallbackClientId);
  const fallbackAgreementId = cleanText(options.agreementId);

  let agreement = null;
  if (sessionId) {
    const { data, error } = await db
      .from('membership_agreements')
      .select('id,client_id,checkout_status,checkout_session_id,admin_email')
      .eq('checkout_session_id', sessionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Agreement checkout lookup failed');
    agreement = data || null;
  }
  if (!agreement && fallbackAgreementId) {
    const { data, error } = await db
      .from('membership_agreements')
      .select('id,client_id,checkout_status,checkout_session_id,admin_email')
      .eq('id', fallbackAgreementId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Agreement checkout lookup failed');
    agreement = data || null;
  }

  let intent = null;
  if (sessionId) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,buyer_email,agreement_id,stripe_checkout_session_id,client_id')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent checkout lookup failed');
    intent = data || null;
  }
  if (!intent && agreement?.id) {
    const { data, error } = await db
      .from('public_purchase_intents')
      .select('id,status,buyer_email,agreement_id,stripe_checkout_session_id,client_id')
      .eq('agreement_id', agreement.id)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Public purchase intent checkout lookup failed');
    intent = data || null;
  }

  const checkoutPaid = cleanText(agreement?.checkout_status).toLowerCase() === 'paid';
  const intentCompleted = !intent?.id || cleanText(intent.status).toLowerCase() === 'completed';
  const clientId = cleanText(agreement?.client_id || intent?.client_id || fallbackClientId);
  if (!checkoutPaid || !intentCompleted || !clientId) {
    return { status: 'payment_pending', client_id: clientId || null };
  }

  const { data: client, error: clientErr } = await db
    .from('clients')
    .select('id,billing_status,subscription_status')
    .eq('id', clientId)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
  const billingActive = cleanText(client?.billing_status).toLowerCase() === 'active';
  const subscriptionStatus = cleanText(client?.subscription_status).toLowerCase();
  const subscriptionActive = !subscriptionStatus || LIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus) || subscriptionStatus === 'active';
  if (!client?.id || !billingActive || !subscriptionActive) {
    return { status: 'activation_pending', client_id: clientId };
  }

  const buyerEmail = lowerEmail(intent?.buyer_email || agreement?.admin_email);
  let memberQuery = db.from('client_members').select('client_id,user_id,email,role').eq('client_id', clientId);
  if (buyerEmail) memberQuery = memberQuery.eq('email', buyerEmail);
  const { data: members, error: memberErr } = await memberQuery;
  if (memberErr) throw new Error(memberErr.message || 'Client member lookup failed');
  const member = Array.isArray(members) ? members[0] : members;
  if (!member?.user_id) return { status: 'setup_pending', client_id: clientId };

  const authUser = await findAuthUserById(authAdmin, member.user_id, logger);
  if (!cleanText(authUser?.last_sign_in_at)) {
    const setupEmail = lowerEmail(buyerEmail || member.email || authUser?.email || agreement?.admin_email);
    const setPasswordUrl = await generatePasswordSetupUrl({
      authAdmin,
      email: setupEmail,
      clientId,
      requestId,
      logger
    });
    if (setPasswordUrl) {
      return {
        status: 'password_required',
        client_id: clientId,
        password_setup_required: true,
        direct_setup_available: true,
        set_password_url: setPasswordUrl
      };
    }

    return {
      status: 'setup_email_sent',
      client_id: clientId,
      password_setup_required: true,
      setup_email_sent: true
    };
  }

  return { status: 'ready', client_id: clientId };
}

module.exports = {
  activatePublicPurchaseAgreementCheckout,
  resolvePublicCheckoutReturnState,
  buildClientActivationPayload,
  findAuthUserByEmail,
  findAuthUserById,
  generatePasswordSetupUrl
};

'use strict';

const { randomUUID } = require('crypto');
const { requireInterviewType: requireCanonicalInterviewType } = require('./interviewTypes');

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeInterviewType(value) {
  return requireCanonicalInterviewType(value);
}

function defaultGenerateRubricAndKBForRole(roleId) {
  const { generateRubricAndKBForRole } = require('./generateRubric');
  return generateRubricAndKBForRole(roleId);
}

async function enrichRoleJobDescription({
  db,
  roleId,
  clientId,
  jdStoragePath,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const safeRoleId = cleanText(roleId);
  const safeClientId = cleanText(clientId);
  const safeJdStoragePath = cleanText(jdStoragePath);
  if (!safeRoleId || !safeClientId || !safeJdStoragePath) return { enriched: false };

  const { error: roleJdUpdateErr } = await db
    .from('roles')
    .update({ job_description_url: safeJdStoragePath })
    .eq('id', safeRoleId)
    .eq('client_id', safeClientId);
  if (roleJdUpdateErr) throw new Error(roleJdUpdateErr.message || 'Role JD update failed');

  await generateRubricAndKBForRole(safeRoleId);
  return { enriched: true };
}

async function createRoleRecordForPurchase({
  db,
  clientId,
  roleTitle,
  interviewType,
  pendingRolePurchaseId = null,
  roleId = null
}) {
  const safeClientId = cleanText(clientId);
  const safeTitle = cleanText(roleTitle);
  if (!safeClientId) throw new Error('Pending role client missing');
  if (!safeTitle) throw new Error('Pending role title missing');
  const normalizedInterviewType = normalizeInterviewType(interviewType);
  const safePendingRolePurchaseId = cleanText(pendingRolePurchaseId);
  const safeRoleId = cleanText(roleId);

  let linkedRoleId = null;
  if (safePendingRolePurchaseId) {
    const { data: linkedRole, error: linkedRoleErr } = await db
      .from('roles')
      .select('id')
      .eq('client_id', safeClientId)
      .eq('pending_role_purchase_id', safePendingRolePurchaseId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (linkedRoleErr) throw new Error(linkedRoleErr.message || 'Role recovery lookup failed');
    linkedRoleId = linkedRole?.id || null;
  }

  let role = linkedRoleId ? { id: linkedRoleId } : null;
  if (!role) {
    const insertPayload = {
      client_id: safeClientId,
      title: safeTitle,
      interview_type: normalizedInterviewType
    };
    if (safeRoleId) insertPayload.id = safeRoleId;
    if (safePendingRolePurchaseId) insertPayload.pending_role_purchase_id = safePendingRolePurchaseId;
    const { data: insertedRole, error: createdRoleErr } = await db
      .from('roles')
      .insert(insertPayload)
      .select('id')
      .single();
    if (createdRoleErr) throw new Error(createdRoleErr.message || 'Role creation failed');
    role = insertedRole;
  }

  return {
    role,
    linkedRoleId,
    recovered: Boolean(linkedRoleId)
  };
}

async function createOrRecoverRoleForPurchase({
  db,
  clientId,
  roleTitle,
  interviewType,
  jdStoragePath,
  pendingRolePurchaseId = null,
  roleId = null,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const created = await createRoleRecordForPurchase({
    db,
    clientId,
    roleTitle,
    interviewType,
    pendingRolePurchaseId,
    roleId
  });

  await enrichRoleJobDescription({
    db,
    roleId: created.role.id,
    clientId,
    jdStoragePath,
    generateRubricAndKBForRole
  });

  return created;
}

async function finalizePendingRolePurchase({
  db,
  pendingRolePurchase,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole
}) {
  const pendingId = cleanText(pendingRolePurchase?.id);
  if (!pendingId) throw new Error('Pending role purchase id missing');

  const created = await createOrRecoverRoleForPurchase({
    db,
    clientId: pendingRolePurchase.client_id,
    roleTitle: pendingRolePurchase.role_title,
    interviewType: pendingRolePurchase.interview_type,
    jdStoragePath: pendingRolePurchase.jd_storage_path,
    pendingRolePurchaseId: pendingId,
    generateRubricAndKBForRole
  });

  const { data: finalizedPendingRolePurchase, error: finalizeErr } = await db
    .from('pending_role_purchases')
    .update({
      finalized_role_id: created.role.id,
      status: 'finalized',
      finalized_at: new Date().toISOString()
    })
    .eq('id', pendingId)
    .is('finalized_role_id', null)
    .in('status', created.linkedRoleId ? ['pending', 'paid', 'finalizing'] : ['finalizing'])
    .select('id')
    .maybeSingle();
  if (finalizeErr || !finalizedPendingRolePurchase) {
    throw new Error(finalizeErr?.message || 'Pending role purchase finalize failed');
  }

  return {
    role: created.role,
    pending_role_purchase_id: pendingId,
    recovered: created.recovered
  };
}

async function findUnusedFirstRolePrepayCredit({ db, billingClientId }) {
  const safeBillingClientId = cleanText(billingClientId);
  if (!safeBillingClientId) return null;
  const { data, error } = await db
    .from('client_role_credits')
    .select('id')
    .eq('billing_client_id', safeBillingClientId)
    .eq('credit_type', 'first_role_prepay')
    .eq('status', 'unused')
    .is('used_at', null)
    .is('used_by_role_id', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'First-role prepay credit lookup failed');
  return data || null;
}

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function plainMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

async function readClaimedCreditMetadata({ db, creditId }) {
  const { data, error } = await db
    .from('client_role_credits')
    .select('metadata')
    .eq('id', creditId)
    .eq('status', 'claimed')
    .maybeSingle();
  if (error) throw new Error(error.message || 'Claimed first-role credit lookup failed');
  return plainMetadata(data?.metadata);
}

async function claimFirstRolePrepayCredit({ db, billingClientId, clientId }) {
  const { data, error } = await db.rpc('claim_first_role_prepay_credit', {
    p_billing_client_id: billingClientId,
    p_source_client_id: clientId,
    p_claim_context: 'role_checkout'
  });
  if (error) throw new Error(error.message || 'First-role prepay credit claim failed');

  const row = firstRpcRow(data);
  if (!row?.ok || !row?.credit_id) {
    return {
      claimed: false,
      status: cleanText(row?.status) || 'credit_not_available'
    };
  }

  return {
    claimed: true,
    credit_id: row.credit_id,
    status: cleanText(row.status) || 'claimed'
  };
}

async function markClaimedFirstRoleCreditUsed({ db, creditId, roleId, clientId }) {
  const safeCreditId = cleanText(creditId);
  const safeRoleId = cleanText(roleId);
  const safeClientId = cleanText(clientId);
  if (!safeCreditId) throw new Error('Claimed first-role credit id missing');
  if (!safeRoleId) throw new Error('Claimed first-role credit role id missing');

  const consumedAt = new Date().toISOString();
  const metadata = {
    ...(await readClaimedCreditMetadata({ db, creditId: safeCreditId })),
    consumed_by: 'role_checkout',
    consumed_client_id: safeClientId || null,
    consumed_at: consumedAt
  };

  const { data, error } = await db
    .from('client_role_credits')
    .update({
      status: 'used',
      used_at: consumedAt,
      used_by_role_id: safeRoleId,
      metadata
    })
    .eq('id', safeCreditId)
    .eq('status', 'claimed')
    .is('used_at', null)
    .is('used_by_role_id', null)
    .select('id')
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || 'Claimed first-role credit use failed');
  return { used_at: consumedAt };
}

async function releaseClaimedFirstRoleCredit({ db, creditId, clientId, reason }) {
  const safeCreditId = cleanText(creditId);
  if (!safeCreditId) return { released: false };

  const releasedAt = new Date().toISOString();
  const metadata = {
    ...(await readClaimedCreditMetadata({ db, creditId: safeCreditId })),
    released_by: 'role_checkout',
    released_client_id: cleanText(clientId) || null,
    release_reason: cleanText(reason) || 'role_creation_failed',
    released_at: releasedAt
  };

  const { data, error } = await db
    .from('client_role_credits')
    .update({
      status: 'unused',
      used_at: null,
      used_by_role_id: null,
      metadata
    })
    .eq('id', safeCreditId)
    .eq('status', 'claimed')
    .is('used_at', null)
    .is('used_by_role_id', null)
    .select('id')
    .maybeSingle();
  if (error || !data) throw new Error(error?.message || 'Claimed first-role credit release failed');
  return { released: true, released_at: releasedAt };
}

async function finalizePrepaidRoleCredit({
  db,
  billingClientId,
  clientId,
  roleTitle,
  interviewType,
  jdStoragePath,
  generateRubricAndKBForRole = defaultGenerateRubricAndKBForRole,
  throwOnEnrichmentError = true,
  logger = console
}) {
  const safeBillingClientId = cleanText(billingClientId);
  const safeClientId = cleanText(clientId);
  const safeTitle = cleanText(roleTitle);
  if (!safeBillingClientId) throw new Error('Billing client id is required for first-role prepay credit.');
  if (!safeClientId) throw new Error('Client id is required for first-role prepay credit.');
  if (!safeTitle) throw new Error('Role title is required for first-role prepay credit.');

  const claim = await claimFirstRolePrepayCredit({
    db,
    billingClientId: safeBillingClientId,
    clientId: safeClientId
  });
  if (!claim.claimed) {
    return {
      applied: false,
      status: claim.status || 'credit_not_available'
    };
  }

  const roleId = randomUUID();
  let created;
  try {
    created = await createRoleRecordForPurchase({
      db,
      clientId: safeClientId,
      roleTitle: safeTitle,
      interviewType,
      roleId
    });
  } catch (error) {
    try {
      await releaseClaimedFirstRoleCredit({
        db,
        creditId: claim.credit_id,
        clientId: safeClientId,
        reason: error?.message || 'role_creation_failed'
      });
    } catch (releaseError) {
      logger.error?.('[role-purchase-finalizer] prepaid_role_credit_release_failed', {
        credit_id: claim.credit_id,
        client_id: safeClientId,
        billing_client_id: safeBillingClientId,
        error: releaseError?.message || releaseError
      });
    }
    throw error;
  }

  await markClaimedFirstRoleCreditUsed({
    db,
    creditId: claim.credit_id,
    roleId: created.role.id,
    clientId: safeClientId
  });

  let enrichmentStatus = 'skipped';
  try {
    const enrichment = await enrichRoleJobDescription({
      db,
      roleId: created.role.id,
      clientId: safeClientId,
      jdStoragePath,
      generateRubricAndKBForRole
    });
    enrichmentStatus = enrichment.enriched ? 'completed' : 'skipped';
  } catch (error) {
    enrichmentStatus = 'failed';
    logger.error?.('[role-purchase-finalizer] prepaid_role_enrichment_failed', {
      role_id: created.role.id,
      credit_id: claim.credit_id,
      client_id: safeClientId,
      billing_client_id: safeBillingClientId,
      error: error?.message || error
    });
    if (throwOnEnrichmentError) throw error;
  }

  return {
    applied: true,
    status: 'used',
    role_id: created.role.id,
    credit_id: claim.credit_id,
    enrichment_status: enrichmentStatus
  };
}

module.exports = {
  createOrRecoverRoleForPurchase,
  enrichRoleJobDescription,
  finalizePendingRolePurchase,
  finalizePrepaidRoleCredit,
  findUnusedFirstRolePrepayCredit,
  normalizeInterviewType
};

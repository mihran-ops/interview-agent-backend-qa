'use strict';

const CLIENT_BILLING_SELECT = [
  'id',
  'name',
  'email',
  'parent_client_id',
  'entity_label',
  'stripe_customer_id',
  'stripe_subscription_id',
  'billing_status',
  'subscription_status',
  'plan_tier',
  'billing_interval',
  'current_term_end',
  'cancel_at_term_end',
  'auto_renew'
].join(',');

function normalizeClientId(clientId) {
  const id = String(clientId || '').trim();
  return id || null;
}

function isChildClient(client) {
  return !!normalizeClientId(client?.parent_client_id);
}

function makeErrorResult(status, code, detail, hint, context) {
  return {
    ok: false,
    status: Number(status) || 500,
    body: {
      error: code,
      code,
      detail,
      hint: hint || null,
      context: context || null
    }
  };
}

function makeClientLookupFailedError(detail, context) {
  return makeErrorResult(
    500,
    'CLIENT_LOOKUP_FAILED',
    detail || 'Client lookup failed.',
    'Billing/legal client checks could not be completed safely.',
    context
  );
}

function makeChildNotAllowedError(context) {
  return makeErrorResult(
    400,
    'CHILD_CLIENT_NOT_ALLOWED',
    'This action must use a parent/top-level client.',
    'Select the parent client that owns billing, membership agreement, subscription, and legal records.',
    context
  );
}

async function loadClientById(db, clientId, context) {
  if (!db || typeof db.from !== 'function') {
    return makeClientLookupFailedError('Database client is not configured.', context);
  }

  const id = normalizeClientId(clientId);
  if (!id) {
    return makeErrorResult(
      400,
      'CLIENT_ID_REQUIRED',
      'Client id is required.',
      'Provide a valid client id.',
      context
    );
  }

  const { data, error } = await db
    .from('clients')
    .select(CLIENT_BILLING_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) return makeClientLookupFailedError(error.message || 'Client lookup failed.', context);
  if (!data) {
    return makeErrorResult(
      404,
      'CLIENT_NOT_FOUND',
      'Client not found.',
      'Verify the selected client exists before continuing.',
      context
    );
  }

  return { ok: true, client: data, clientId: data.id };
}

async function loadClientWithBillingOwner(db, clientId) {
  const scopeResult = await loadClientById(db, clientId, { client_id: normalizeClientId(clientId) });
  if (!scopeResult.ok) return scopeResult;

  const scopeClient = scopeResult.client;
  const parentClientId = normalizeClientId(scopeClient.parent_client_id);
  if (!parentClientId) {
    return {
      ok: true,
      scopeClient,
      billingClient: scopeClient,
      scopeClientId: scopeClient.id,
      billingClientId: scopeClient.id,
      isChildClient: false,
      isParentClient: true
    };
  }

  const billingResult = await loadClientById(db, parentClientId, {
    client_id: scopeClient.id,
    parent_client_id: parentClientId
  });
  if (!billingResult.ok) {
    if (billingResult.status === 404) {
      return makeErrorResult(
        500,
        'BILLING_OWNER_NOT_FOUND',
        'Parent billing client was not found.',
        'Client billing owner resolution could not be completed safely.',
        { client_id: scopeClient.id, parent_client_id: parentClientId }
      );
    }
    return {
      ...billingResult,
      body: {
        ...billingResult.body,
        code: billingResult.body?.code || 'BILLING_OWNER_LOOKUP_FAILED',
        error: billingResult.body?.error || 'BILLING_OWNER_LOOKUP_FAILED',
        context: billingResult.body?.context || {
          client_id: scopeClient.id,
          parent_client_id: parentClientId
        }
      }
    };
  }
  const resolvedBillingParentClientId = normalizeClientId(billingResult.client.parent_client_id);
  if (resolvedBillingParentClientId) {
    return makeErrorResult(
      500,
      'INVALID_BILLING_OWNER',
      'Resolved billing owner is not a parent/top-level client.',
      'Billing owner resolution could not be completed safely.',
      {
        client_id: scopeClient.id,
        parent_client_id: parentClientId,
        resolved_billing_client_id: billingResult.client.id,
        resolved_billing_parent_client_id: resolvedBillingParentClientId
      }
    );
  }

  return {
    ok: true,
    scopeClient,
    billingClient: billingResult.client,
    scopeClientId: scopeClient.id,
    billingClientId: billingResult.client.id,
    isChildClient: true,
    isParentClient: false
  };
}

async function requireParentClient(db, clientId, context) {
  const resolved = await loadClientWithBillingOwner(db, clientId);
  if (!resolved.ok) {
    return {
      ...resolved,
      body: {
        ...resolved.body,
        context: resolved.body?.context || context || null
      }
    };
  }

  if (resolved.isChildClient) {
    return makeChildNotAllowedError({
      ...(context || {}),
      client_id: resolved.scopeClientId,
      parent_client_id: resolved.billingClientId
    });
  }

  return {
    ok: true,
    client: resolved.scopeClient,
    clientId: resolved.scopeClientId
  };
}

async function resolveBillingOwnerForScope(db, clientId) {
  return loadClientWithBillingOwner(db, clientId);
}

module.exports = {
  loadClientWithBillingOwner,
  requireParentClient,
  resolveBillingOwnerForScope,
  normalizeClientId,
  isChildClient,
  makeChildNotAllowedError,
  makeClientLookupFailedError
};

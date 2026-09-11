'use strict';

// Client-facing billing helpers: dashboard tabs, write access and scope errors.



const CLIENT_DASHBOARD_TABS = new Set(['roles', 'candidates', 'members', 'billing', 'feedback'])
function sanitizeClientDashboardTab(value, fallback) {
  const raw = String(value || '').trim().toLowerCase()
  return CLIENT_DASHBOARD_TABS.has(raw) ? raw : fallback
}

function getClientMembershipRole(req, clientId) {
  const targetClientId = String(clientId || '').trim()
  if (!targetClientId) return ''
  const memberships = Array.isArray(req?.memberships) ? req.memberships : []
  const membership = memberships.find((item) => String(item?.client_id || '').trim() === targetClientId)
  return String(membership?.role || '').trim().toLowerCase()
}

function hasClientWriteAccess(req, clientId) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true
  const role = getClientMembershipRole(req, clientId)
  return role === 'manager' || role === 'admin' || role === 'super_admin'
}

function wantsEmbeddedCheckout(value) {
  if (value === true) return true
  const raw = String(value || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'embedded'
}

function respondWithBillingScopeError(res, result, fallbackError) {
  const body = result?.body || {}
  return res.status(result?.status || 500).json({
    error: body.error || body.code || fallbackError || 'billing_client_lookup_failed',
    detail: body.detail || 'Billing client lookup failed.'
  })
}


module.exports = {
  CLIENT_DASHBOARD_TABS,
  getClientMembershipRole,
  hasClientWriteAccess,
  respondWithBillingScopeError,
  sanitizeClientDashboardTab,
  wantsEmbeddedCheckout,
};

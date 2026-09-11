// app.js (drop-in)
require('dotenv').config()

// --- Sentry MUST be initialized before requiring Express to instrument it ---
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');
const {
  getTavusWebhookAuthReadiness,
  redactTavusWebhookAuth,
} = require('./src/lib/tavusWebhookAuth');
const { redactOtpLaunchTelemetry } = require('./src/lib/otpLaunchTelemetry');
const SENTRY_ENABLED = process.env.SENTRY_ENABLED === '1' && !!process.env.SENTRY_DSN;
if (SENTRY_ENABLED) {
  const integrations = [];
  try { if (typeof Sentry.httpIntegration === 'function') integrations.push(Sentry.httpIntegration()); } catch {}
  try { if (typeof Sentry.expressIntegration === 'function') integrations.push(Sentry.expressIntegration()); } catch {}
  try { if (typeof nodeProfilingIntegration === 'function') integrations.push(nodeProfilingIntegration()); } catch {}
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
    release: process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    integrations,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.0),
    beforeSend(event) {
      try {
        if (event.request?.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
          delete event.request.headers['telnyx-signature-ed25519'];
          delete event.request.headers['telnyx-timestamp'];
        }
        const scrub = (s) =>
          typeof s === 'string'
            ? s
                .replace(/[^@\s]+@[^@\s]+\.[^@\s]+/g, '***@***')
                .replace(/(X-Amz-Signature|Signature)=[^&]+/g, '$1=REDACTED')
                .replace(/(Authorization|Bearer)\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, '$1 REDACTED')
            : s;
        if (event.request?.url) event.request.url = scrub(event.request.url);
        if (/\/api\/candidate\/(?:submit|verify-otp)(?:\/|$)|\/webhook\/telnyx\/sms(?:\/|$)/.test(String(event.request?.url || ''))) {
          delete event.request.data;
        }
        if (event.extra) {
          for (const k of Object.keys(event.extra)) {
            if (typeof event.extra[k] === 'string') event.extra[k] = scrub(event.extra[k]);
          }
        }
      } catch (_) {}
      return redactTavusWebhookAuth(redactOtpLaunchTelemetry(event));
    },
    beforeSendTransaction(event) {
      redactOtpLaunchTelemetry(event);
      return redactTavusWebhookAuth(event);
    },
    beforeSendSpan(span) {
      redactOtpLaunchTelemetry(span);
      return redactTavusWebhookAuth(span);
    },
  });
}

// Now import Express and other modules
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const fs = require('fs')
const multer = require('multer')
const path = require('path')
const { supabaseAdmin } = require('./src/lib/supabaseClient')
const { generateRubricAndKBForRole, makeKBFromRubric } = require('./generateRubric')
const { ensureTavusDocumentForRole } = require('./lib/tavusDocuments')
const axios = require('axios')
const dashboardRouter = require('./routes/dashboard')
const rolesRouter = require('./routes/roles')
const { createRoleJdReplacementRouter } = require('./routes/roleJdReplacement')
const automationRouter = require('./routes/automation')
const { requireAuth, withClientScope } = require('./src/middleware/auth')
const { createProfileRouter } = require('./routes/profile')
const { createSupportVoiceGateway } = require('./src/lib/supportVoiceGateway')
const { buildClientScopeContext, canViewLegalBillingForClient } = require('./src/lib/clientScope')
const {
  entityFieldsForClientId,
  loadEntityMap,
  resolveEntityFilter,
  uniqueIds: uniqueEntityIds,
  withEntityFields,
} = require('./src/lib/entityScopeFilter')
const { requireParentClient, resolveBillingOwnerForScope } = require('./src/lib/clientBillingScope')
const { normalizeCriteriaConfig, stableStringify } = require('./src/lib/candidateAutomationEvaluator')
const { getRoleInterviewAvailability } = require('./src/lib/roleInterviewAvailability')
const { getRoleJdReplacementEligibility } = require('./src/lib/roleJdReplacement')
const { createInterviewRecoveryRouter } = require('./routes/interviewRecovery')
const { createAdminInterviewReliabilityRouter } = require('./routes/adminInterviewReliability')
const { normalizeUuid } = require('./src/lib/strictRequestValidation')
const { isInterviewRecoveryCoreEnabled, isInterviewRecoveryCoreEmailEnabled } = require('./src/lib/interviewAttemptService')
const { cleanupNoSubstantiveRecordings } = require('./src/lib/recordingCleanup')
const { normalizeInterviewType, normalizeRoleInterviewTypeForRead } = require('./src/lib/interviewTypes')
const { createSubscriptionCheckoutSession } = require('./src/lib/subscriptionCheckout')
const {
  finalizePrepaidRoleCredit,
  findUnusedFirstRolePrepayCredit
} = require('./src/lib/rolePurchaseFinalizer')
const { processClientEntityImport } = require('./src/lib/clientEntityImportService')
const { archiveChildClientEntity, restoreChildClientEntity } = require('./src/lib/clientEntityArchive')
const { buildAdminMetricsPayload, safeErrorBody } = require('./src/lib/adminMetricsService')
const { createAdminSmsMonitoringRouter } = require('./routes/adminSmsMonitoring')
const { resolvePublicCheckoutReturnState } = require('./src/lib/publicPurchaseActivation')
const {
  archivePublicLeadCapture,
  buildAdminPublicAnalyticsLeadsCsv,
  buildAdminPublicAnalyticsPayload,
  safePublicAnalyticsErrorBody,
  unarchivePublicLeadCapture,
  updatePublicLeadCaptureArchiveBatch,
} = require('./src/lib/adminPublicAnalyticsService')
const {
  buildAdminPublicPurchasesPayload,
  resendPublicPurchaseAgreementLink,
  resendPublicPurchaseCheckoutLink,
  resendPublicPurchaseSetupEmail,
  resendPublicPurchaseWelcomeEmail,
  safePublicPurchaseActionErrorBody,
  safePublicPurchasesErrorBody,
} = require('./src/lib/adminPublicPurchasesService')
const {
  sendSubscriptionCheckoutEmail,
  sendMemberRecoveryEmail,
  sendAlphaScreenWelcomeEmail,
  sendMembershipAgreementEmail,
} = require('./utils/mailer')
const {
  frontendUrl: FRONTEND_URL,
  interviewAppBase: INTERVIEW_APP_BASE,
  corsDefaultOrigins,
  isInterviewPrettyLinkHost,
  resolvePublicBackendBase,
  buildPublicAccountUrl,
  buildClientDashboardReturnUrl,
  buildAdminDashboardUrl,
  buildClientPwResetUrl,
  buildPublicPwResetUrl,
  buildPublicCheckoutSuccessUrl,
  buildAcceptInviteUrl
} = require('./config/urlConfig')
const ROLE_CHECKOUT_JD_BUCKET = (process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET || process.env.SUPABASE_JD_BUCKET || 'job-descriptions').trim()
const roleCheckoutUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
})
const app = express()
const configuredTrustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 1)
app.set('trust proxy', Number.isInteger(configuredTrustProxyHops) && configuredTrustProxyHops >= 0
  ? configuredTrustProxyHops
  : 1)

// Sentry request middleware (must be before other app.use and routes)
if (SENTRY_ENABLED) {
  if (typeof Sentry.expressRequestMiddleware === 'function') {
    app.use(Sentry.expressRequestMiddleware()); // v8+
  } else if (Sentry.Handlers && typeof Sentry.Handlers.requestHandler === 'function') {
    app.use(Sentry.Handlers.requestHandler()); // v7
  }
}

// QA dashboard browser voice has its own strict Origin/CORS/body contract and
// must mount before the application's broader CORS and JSON middleware.
const supportVoiceGateway = createSupportVoiceGateway({
  requireAuth,
  serviceDb: supabaseAdmin,
  captureProviderAlert(metadata) {
    if (!SENTRY_ENABLED) return;
    try {
      Sentry.captureMessage('support_voice_provider_contract_failed', {
        level: 'error',
        tags: {
          feature: 'support_voice',
          failure_category: metadata.failure_category,
          field: metadata.field || 'none',
        },
        extra: { consecutive_failures: metadata.consecutive_failures },
      });
    } catch {}
  },
})
app.use('/api/support/voice', supportVoiceGateway.router)

// ---------- CORS ----------
const DEFAULT_ORIGINS = corsDefaultOrigins
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const ALLOWLIST = Array.from(new Set([
  ...DEFAULT_ORIGINS,
  FRONTEND_URL.replace(/\/+$/, ''),
  ...envOrigins
].filter(Boolean)))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / same-origin
    if (ALLOWLIST.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'X-AlphaScreen-OTP-Launch',
    'X-Requested-With',
    'apikey',
    'x-client-info',
    'Prefer',
    'Range',
    'Accept'
  ],
  exposedHeaders: ['Content-Range', 'Range-Unit']
}))

app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require('./routes/webhookStripe'))
app.use('/webhook/telnyx/sms', express.raw({ type: 'application/json', limit: '256kb' }), require('./routes/webhookTelnyxSms'))
app.use('/webhook/sendgrid', express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.raw_body = Buffer.from(buffer);
  }
}), require('./routes/webhookSendgrid'))
app.use('/webhook', require('./routes/webhook'))

app.use(express.json({ limit: '10mb' }))

// ---------- CSP: allow Wix to embed (frame-ancestors) ----------
app.use((req, res, next) => {
  try {
    const cspFrameAncestors = String(
      process.env.CSP_FRAME_ANCESTORS || `'self' ${FRONTEND_URL} https://*.wixsite.com https://*.filesusr.com`
    ).trim();
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      `base-uri 'self'; object-src 'none'; frame-ancestors ${cspFrameAncestors};`
    );
    // Ensure we don't send legacy X-Frame-Options that could conflict with CSP
    res.removeHeader && res.removeHeader('X-Frame-Options');
  } catch (_) {}
  next();
});
// ---------- Permissions-Policy: allow Tavus (daily.co) to access camera/mic in nested iframes ----------
app.use((req, res, next) => {
  try {
    res.setHeader(
      'Permissions-Policy',
      'camera=(self "https://tavus.daily.co" "https://c.daily.co"), microphone=(self "https://tavus.daily.co" "https://c.daily.co"), display-capture=(self "https://tavus.daily.co" "https://c.daily.co"), fullscreen=(self "https://tavus.daily.co" "https://c.daily.co"), autoplay=(self "https://tavus.daily.co" "https://c.daily.co"), clipboard-read=(self), clipboard-write=(self)'
    );
  } catch (_) {}
  next();
});

app.use((req, res, next) => {
  try {
    const pathName = String(req.path || '');
    if (
      pathName.startsWith('/admin') ||
      pathName.startsWith('/clients') ||
      pathName.startsWith('/client-members') ||
      pathName.startsWith('/dashboard') ||
      pathName.startsWith('/roles') ||
      pathName.startsWith('/reports') ||
      pathName.startsWith('/files') ||
      pathName.startsWith('/membership-agreements')
    ) {
      res.setHeader('Cache-Control', 'private, no-store');
    }
  } catch (_) {}
  next();
});

// Per-request context (request_id + basic tags)
app.use((req, _res, next) => {
  try {
    const rid = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    req.request_id = rid;
    if (Sentry?.getCurrentScope) {
      Sentry.setTag('request_id', rid);
      if (req.user?.id) Sentry.setUser({ id: req.user.id, email: req.user.email || undefined });
    }
  } catch (_) {}
  next();
});

// ---------- auth middlewares ----------
// NOTE: Auth + client scoping are centralized in src/middleware/auth

// ---------- Public candidate endpoints (MOUNTED) ----------
app.use('/api/candidate/submit', require('./routes/candidateSubmit'))
app.use('/api/candidate/verify-otp', require('./routes/verifyOtp'))
app.use('/create-tavus-interview', require('./routes/createTavusInterview'))
app.use('/api/accommodations', require('./routes/accommodationRequests'))
app.use('/api/text-interview', require('./routes/textInterview'))

// ---------- Simple test endpoint ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

function uniqueClientIds(ids) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean)))
}

async function loadClientScopeContextForResponse(req, knownClients) {
  const effectiveIds = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
  let clients = Array.isArray(knownClients) ? knownClients.slice() : []
  const knownClientIds = new Set(clients.map(c => String(c?.id || '').trim()).filter(Boolean))
  const missingClientIds = effectiveIds.filter(id => !knownClientIds.has(id))

  if (missingClientIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id, name, parent_client_id, entity_label, archived_at')
      .in('id', missingClientIds)
    if (!error && Array.isArray(data)) clients = clients.concat(data)
  }

  return buildClientScopeContext({
    memberships: req.effectiveMemberships || req.memberships || [],
    clients,
  })
}

function clientScopeMetadata(scopeContext, clientId) {
  const id = String(clientId || '').trim()
  const client = scopeContext?.clientById?.[id] || { id }
  const permissions = scopeContext?.permissionsByClientId?.[id] || {
    can_create_roles: false,
    can_purchase_interviews: false,
    can_view_legal_billing: false,
    can_manage_members: false,
  }

  return {
    parent_client_id: client.parent_client_id || null,
    entity_label: client.entity_label || null,
    archived_at: client.archived_at || null,
    billing_client_id: client.billing_client_id || id || null,
    is_parent_client: client.is_parent_client !== false,
    is_child_client: client.is_child_client === true,
    permissions,
  }
}

function normalizeTenantRole(role) {
  const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return normalized === 'superadmin' ? 'super_admin' : normalized
}

const TENANT_ENTITY_MANAGER_ROLES = new Set(['manager', 'admin', 'owner', 'super_admin'])

function findEffectiveClientMembership(req, clientId) {
  const targetClientId = String(clientId || '').trim()
  if (!targetClientId) return null
  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : Array.isArray(req?.effectiveMemberships)
      ? req.effectiveMemberships
      : Array.isArray(req?.memberships)
        ? req.memberships
        : []
  return memberships.find(m => String(m?.client_id || '').trim() === targetClientId) || null
}

function hasTenantEntityManagementAccess(req, parentClientId) {
  const parentId = String(parentClientId || '').trim()
  if (!parentId) return false
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true

  const parentMembership = findEffectiveClientMembership(req, parentId)
  if (TENANT_ENTITY_MANAGER_ROLES.has(normalizeTenantRole(parentMembership?.role))) return true

  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : Array.isArray(req?.effectiveMemberships)
      ? req.effectiveMemberships
      : Array.isArray(req?.memberships)
        ? req.memberships
        : []
  return memberships.some(m => (
    TENANT_ENTITY_MANAGER_ROLES.has(normalizeTenantRole(m?.role)) &&
    m?.inherited === true &&
    String(m?.inherited_from_client_id || '').trim() === parentId
  ))
}

function formatTenantClientEntity(client) {
  const parentClientId = String(client?.parent_client_id || '').trim() || null
  return {
    id: client?.id || null,
    name: client?.name || null,
    parent_client_id: parentClientId,
    entity_label: String(client?.entity_label || '').trim() || null,
    archived_at: String(client?.archived_at || '').trim() || null,
    archived_reason: String(client?.archived_reason || '').trim() || null,
    archived_by_user_id: String(client?.archived_by_user_id || '').trim() || null,
    archived: Boolean(String(client?.archived_at || '').trim()),
    billing_client_id: parentClientId || client?.id || null,
    is_parent_client: !parentClientId,
    is_child_client: !!parentClientId,
  }
}

async function resolveTenantEntityParent(req, selectedClientId) {
  const clientId = String(selectedClientId || '').trim()
  if (!clientId) {
    return { ok: false, status: 400, body: { error: 'client_id_required' } }
  }

  const { data: selected, error: selectedError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', clientId)
    .maybeSingle()

  if (selectedError) {
    return { ok: false, status: 500, body: { error: 'client_lookup_failed', detail: selectedError.message } }
  }
  if (!selected) {
    return { ok: false, status: 404, body: { error: 'client_not_found' } }
  }

  const selectedParentId = String(selected.parent_client_id || '').trim()
  if (!selectedParentId) {
    if (!hasTenantEntityManagementAccess(req, selected.id)) {
      return { ok: false, status: 403, body: { error: 'forbidden' } }
    }
    return { ok: true, parent: selected, selected }
  }

  const { data: parent, error: parentError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', selectedParentId)
    .maybeSingle()

  if (parentError) {
    return { ok: false, status: 500, body: { error: 'parent_client_lookup_failed', detail: parentError.message } }
  }
  if (!parent || String(parent.parent_client_id || '').trim()) {
    return {
      ok: false,
      status: 400,
      body: { error: 'invalid_parent_client', detail: 'Client hierarchy could not be resolved safely.' }
    }
  }
  if (!hasTenantEntityManagementAccess(req, parent.id)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } }
  }

  return { ok: true, parent, selected }
}

// ---------- Auth me ----------
app.get('/auth/me', requireAuth, withClientScope, async (req, res) => {
  let scopeContext = null
  try {
    scopeContext = await loadClientScopeContextForResponse(req)
  } catch (_) {
    scopeContext = buildClientScopeContext({ memberships: req.memberships || [], clients: [] })
  }

  const effectiveClientIds = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
  const assignedClientIds = uniqueClientIds(req.assignedClientIds || [])
  const memberships = (req.effectiveMemberships || req.memberships || []).map(m => ({
    ...m,
    ...clientScopeMetadata(scopeContext, m.client_id),
  }))
  const assignedMemberships = (req.assignedMemberships || req.directMemberships || []).map(m => ({
    ...m,
    ...clientScopeMetadata(scopeContext, m.client_id),
  }))

  return res.json({
    user: {
      id: req.user?.id || null,
      email: req.user?.email || null,
    },
    isGlobalAdmin: req.isGlobalAdmin === true,
    client_scope: {
      client_ids: effectiveClientIds,
      client_ids_count: effectiveClientIds.length,
      memberships,
      default_client_id: req.query?.client_id || null,
      assigned_client_ids: assignedClientIds,
      accessible_client_ids: effectiveClientIds,
      assigned_memberships: assignedMemberships,
    }
  })
})

app.use('/auth/profile', requireAuth, withClientScope, createProfileRouter({ db: supabaseAdmin }))

// ---------- Clients: my ----------
app.get('/clients/my', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = uniqueClientIds(req.effectiveClientIds || req.clientIds || [])
    if (ids.length === 0) return res.json({ items: [] })

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id, name, parent_client_id, entity_label, archived_at')
      .in('id', ids)
    if (error) return res.status(500).json({ error: 'Failed to load clients', detail: error.message })

    const activeClients = (clients || []).filter((client) => (
      !String(client?.parent_client_id || '').trim() ||
      !String(client?.archived_at || '').trim()
    ))

    let scopeContext = null
    try {
      scopeContext = await loadClientScopeContextForResponse(req, activeClients)
    } catch (_) {
      scopeContext = buildClientScopeContext({ memberships: req.memberships || [], clients: activeClients })
    }

    const membershipById = Object.fromEntries((req.effectiveMemberships || req.memberships || []).map(m => [m.client_id, m]))
    const items = activeClients.map((c) => {
      const membership = membershipById[c.id] || {}
      const inherited = membership.inherited === true
      return {
        client_id: c.id,
        name: c.name,
        role: membership.role || 'member',
        inherited,
        inherited_from_client_id: inherited ? (membership.inherited_from_client_id || c.parent_client_id || null) : null,
        ...clientScopeMetadata(scopeContext, c.id),
      }
    })
    res.json({
      items,
      assigned_client_ids: uniqueClientIds(req.assignedClientIds || []),
      accessible_client_ids: activeClients.map((client) => client.id).filter(Boolean),
    })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/clients/entities', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const { data: children, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .eq('parent_client_id', parentResult.parent.id)
      .is('archived_at', null)
      .order('name', { ascending: true })

    if (error) return res.status(500).json({ error: 'list_client_entities_failed', detail: error.message, request_id })

    return res.json({
      ok: true,
      parent: formatTenantClientEntity(parentResult.parent),
      items: (children || []).map(formatTenantClientEntity),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

app.post('/clients/entities', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const name = String(req.body?.name || '').trim()
    const entityLabel = String(req.body?.entity_label || '').trim() || null
    if (!name) return res.status(400).json({ error: 'name_required', request_id })

    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const parent = parentResult.parent
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        detail: 'Client hierarchy could not be resolved safely.',
        request_id
      })
    }

    const { data: created, error } = await supabaseAdmin
      .from('clients')
      .insert({
        name,
        email: parent.email,
        parent_client_id: parent.id,
        entity_label: entityLabel,
        candidate_assistance_contact: parent.candidate_assistance_contact || null
      })
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .single()

    if (error) return res.status(500).json({ error: 'create_client_entity_failed', detail: error.message, hint: error.hint, request_id })

    return res.json({
      ok: true,
      item: formatTenantClientEntity(created),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/create] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

app.post('/clients/entities/import', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.parent_client_id || req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null
    if (!rawRows) {
      return res.status(400).json({
        error: 'rows_required',
        code: 'ROWS_REQUIRED',
        detail: 'rows must be an array.',
        hint: null,
        request_id
      })
    }
    if (rawRows.length > 250) {
      return res.status(400).json({
        error: 'too_many_rows',
        code: 'TOO_MANY_ROWS',
        detail: 'Entity import is limited to 250 rows per upload.',
        hint: null,
        request_id
      })
    }

    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) {
      return res.status(parentResult.status).json({
        error: parentResult.body?.error || 'client_scope_failed',
        code: parentResult.body?.code || String(parentResult.body?.error || 'client_scope_failed').toUpperCase(),
        detail: parentResult.body?.detail || null,
        hint: parentResult.body?.hint || null,
        request_id
      })
    }

    const parent = parentResult.parent
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        code: 'INVALID_PARENT_CLIENT',
        detail: 'Client hierarchy could not be resolved safely.',
        hint: null,
        request_id
      })
    }

    const { data: existingChildren, error: existingError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('parent_client_id', parent.id)
      .is('archived_at', null)

    if (existingError) {
      return res.status(500).json({
        error: 'existing_entities_lookup_failed',
        code: 'EXISTING_ENTITIES_LOOKUP_FAILED',
        detail: existingError.message,
        hint: existingError.hint || null,
        request_id
      })
    }

    const importResult = await processClientEntityImport({
      db: supabaseAdmin,
      authAdmin: supabaseAdmin.auth?.admin,
      parent,
      rawRows,
      existingChildren,
      formatEntity: formatTenantClientEntity
    })

    return res.json({
      ok: true,
      parent: formatTenantClientEntity(parent),
      counts: importResult.counts,
      results: importResult.results,
      created: importResult.created,
      temporary_credentials: importResult.temporary_credentials,
      sensitive_result: importResult.temporary_credentials.length > 0,
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/import] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})

app.patch('/clients/entities/:entityClientId', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const entityClientId = String(req.params?.entityClientId || '').trim()
    if (!entityClientId) return res.status(404).json({ error: 'entity_client_not_found', request_id })

    const { data: entity, error: entityError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('id', entityClientId)
      .maybeSingle()

    if (entityError) return res.status(500).json({ error: 'entity_client_lookup_failed', detail: entityError.message, request_id })
    if (!entity) return res.status(404).json({ error: 'entity_client_not_found', request_id })

    const parentClientId = String(entity.parent_client_id || '').trim()
    if (!parentClientId) return res.status(400).json({ error: 'child_entity_required', request_id })

    const { data: parent, error: parentError } = await supabaseAdmin
      .from('clients')
      .select('id,name,parent_client_id,entity_label,archived_at')
      .eq('id', parentClientId)
      .maybeSingle()

    if (parentError) return res.status(500).json({ error: 'parent_client_lookup_failed', detail: parentError.message, request_id })
    if (!parent || String(parent.parent_client_id || '').trim()) {
      return res.status(400).json({
        error: 'invalid_parent_client',
        detail: 'Client hierarchy could not be resolved safely.',
        request_id
      })
    }
    if (!hasTenantEntityManagementAccess(req, parent.id)) {
      return res.status(403).json({ error: 'forbidden', request_id })
    }

    const updates = {}
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      const name = String(req.body?.name || '').trim()
      if (!name) return res.status(400).json({ error: 'name_required', request_id })
      updates.name = name
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'entity_label')) {
      updates.entity_label = String(req.body?.entity_label || '').trim() || null
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_update_fields', request_id })

    const { data: updated, error } = await supabaseAdmin
      .from('clients')
      .update(updates)
      .eq('id', entity.id)
      .select('id,name,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
      .single()

    if (error) return res.status(500).json({ error: 'update_client_entity_failed', detail: error.message, hint: error.hint, request_id })

    return res.json({
      ok: true,
      item: formatTenantClientEntity(updated),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/update] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', request_id })
  }
})

app.patch('/clients/entities/:entityClientId/archive', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const selectedClientId = req.body?.client_id || req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || null
    const parentResult = await resolveTenantEntityParent(req, selectedClientId)
    if (!parentResult.ok) return res.status(parentResult.status).json({ ...parentResult.body, request_id })

    const result = await archiveChildClientEntity({
      db: supabaseAdmin,
      parentClientId: parentResult.parent.id,
      entityClientId: req.params?.entityClientId,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || null,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: true,
        archived_at: result.entity?.archived_at || null,
      },
      item: formatTenantClientEntity(result.entity),
      request_id
    })
  } catch (e) {
    console.error('[clients/entities/archive] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'server_error', code: 'SERVER_ERROR', detail: e?.message || null, request_id })
  }
})

app.get('/clients/billing/summary', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    if (ids.length === 0) return res.json({ items: [] })

    const wantedClientId = String(req.query?.client_id || '').trim()
    if (wantedClientId && !ids.includes(wantedClientId)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true

    let queryIds = ids
    if (wantedClientId) {
      if (!isGlobalAdmin && !canViewLegalBillingForClient(req.clientScope, wantedClientId)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, wantedClientId)
      if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
      queryIds = [billingScope.billingClientId || wantedClientId]
    } else if (!isGlobalAdmin) {
      queryIds = ids.filter((clientId) => canViewLegalBillingForClient(req.clientScope, clientId))
      if (queryIds.length === 0) return res.status(403).json({ error: 'forbidden' })
    }

    let q = supabaseAdmin
      .from('clients')
      .select('id,name,plan_tier,billing_status,billing_interval,auto_renew,current_term_end,contract_end_at,subscription_status,cancel_at_term_end,access_override_mode,stripe_customer_id')
      .in('id', Array.from(new Set(queryIds)))
      .order('name', { ascending: true })

    const { data, error } = await q
    if (error) return res.status(500).json({ error: 'list_billing_summary_failed', detail: error.message })

    const items = (data || []).map((client) => ({
      id: client.id,
      name: client.name,
      plan_tier: client.plan_tier,
      billing_status: client.billing_status,
      billing_interval: client.billing_interval,
      auto_renew: client.auto_renew,
      current_term_end: client.current_term_end,
      contract_end_at: client.contract_end_at,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      access_override_mode: client.access_override_mode,
      has_stripe_customer: !!client.stripe_customer_id
    }))
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'server_error' })
  }
})

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

app.post('/clients/billing/portal-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (!stripeCustomerId) return res.status(400).json({ error: 'missing_stripe_customer' })

    const stripe = require('./lib/stripeClient')
    const returnParams = new URLSearchParams({
      client_id: clientId,
      tab
    })
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: buildClientDashboardReturnUrl(returnParams)
    })
    return res.json({ ok: true, url: session?.url || null })
  } catch (e) {
    return res.status(500).json({ error: 'create_portal_session_failed', detail: e?.message || 'create_portal_session_failed' })
  }
})

app.post('/clients/billing/additional-interviews/checkout-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded)
    const parsedQuantity = Number(req.body?.quantity)
    const quantity = Number.isInteger(parsedQuantity) ? parsedQuantity : NaN

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleId) return res.status(400).json({ error: 'role_id_required' })
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_quantity' })
    }
    const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, clientId)
    if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
    const billingClient = billingScope.billingClient || {}
    const billingClientId = billingScope.billingClientId || clientId

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle()
    if (roleErr) return res.status(500).json({ error: 'role_lookup_failed', detail: roleErr.message })
    if (!role) return res.status(404).json({ error: 'role_not_found' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('additional_interview_fee')
      .eq('client_id', billingClientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })

    const additionalInterviewFee = Number(planSettings?.additional_interview_fee)
    if (!Number.isFinite(additionalInterviewFee) || additionalInterviewFee <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }
    const additionalInterviewCents = Math.round(additionalInterviewFee * 100)
    if (!Number.isFinite(additionalInterviewCents) || additionalInterviewCents <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }

    const { data: pendingPurchase, error: pendingPurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .insert({
        client_id: clientId,
        role_id: roleId,
        quantity,
        status: 'pending'
      })
      .select('id')
      .single()
    if (pendingPurchaseErr) {
      return res.status(500).json({ error: 'create_role_interview_purchase_failed', detail: pendingPurchaseErr.message })
    }

    const stripe = require('./lib/stripeClient')

    let stripeCustomerId = String(billingClient.stripe_customer_id || '').trim()
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId)
      } catch (e) {
        const code = String(e?.code || '').toLowerCase()
        const message = String(e?.message || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) {
          stripeCustomerId = ''
        } else {
          throw e
        }
      }
    }
    if (!stripeCustomerId) {
      const email = String(billingClient.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: billingClient.name || undefined,
          email: String(billingClient.email || '').trim() || undefined,
          metadata: {
            client_id: billingClientId,
            billing_client_id: billingClientId,
            scope_client_id: clientId
          }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(billingClient.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingClientId)
        if (saveCustomerError) {
          return res.status(500).json({ error: 'client_update_failed', detail: saveCustomerError.message })
        }
      }
    }

    const sessionMetadata = {
      purchase_type: 'additional_interviews',
      role_interview_purchase_id: String(pendingPurchase.id || ''),
      client_id: clientId,
      role_id: roleId,
      quantity: String(quantity)
    }
    const successParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'success',
      client_id: clientId,
      role_id: roleId
    })
    const cancelParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'cancel',
      client_id: clientId,
      role_id: roleId
    })
    const checkoutBasePayload = {
      mode: 'payment',
      customer: stripeCustomerId || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: additionalInterviewCents,
          product_data: {
            name: 'Additional interviews'
          }
        },
        quantity
      }],
      allow_promotion_codes: true,
      metadata: sessionMetadata
    }

    let checkoutClientSecret = null
    let primaryCheckoutSession = null
    let hostedFallbackSession = null

    if (embeddedCheckoutRequested) {
      try {
        primaryCheckoutSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          ui_mode: 'embedded',
          return_url: buildClientDashboardReturnUrl(successParams)
        })
        const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
        if (resolvedClientSecret) {
          checkoutClientSecret = resolvedClientSecret
        } else {
          primaryCheckoutSession = null
        }
      } catch (embeddedErr) {
        console.error('create_additional_interviews_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
      }
    }

    if (!primaryCheckoutSession) {
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: buildClientDashboardReturnUrl(successParams),
        cancel_url: buildClientDashboardReturnUrl(cancelParams)
      })
    } else {
      try {
        hostedFallbackSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          success_url: buildClientDashboardReturnUrl(successParams),
          cancel_url: buildClientDashboardReturnUrl(cancelParams)
        })
      } catch (hostedFallbackErr) {
        console.error('create_additional_interviews_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
      }
    }

    const checkoutUrl = String(hostedFallbackSession?.url || primaryCheckoutSession?.url || '').trim() || null
    const checkoutSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim() || null

    const { error: updatePurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .update({
        stripe_checkout_session_id: checkoutSessionId
      })
      .eq('id', pendingPurchase.id)
    if (updatePurchaseErr) {
      return res.status(500).json({ error: 'update_role_interview_purchase_failed', detail: updatePurchaseErr.message })
    }

    return res.json({
      ok: true,
      url: checkoutUrl,
      role_interview_purchase_id: pendingPurchase.id,
      checkout_client_secret: checkoutClientSecret,
      embedded_checkout: !!checkoutClientSecret
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_additional_interviews_checkout_session_failed', detail: e?.message || 'create_additional_interviews_checkout_session_failed' })
  }
})

app.post('/clients/roles/checkout-session', requireAuth, withClientScope, roleCheckoutUpload.single('file'), async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'roles')
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded)
    const roleTitle = String(req.body?.role_title || '').trim()
    const interviewType = normalizeInterviewType(req.body?.interview_type)
    const jdFile = req.file || null

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleTitle) return res.status(400).json({ error: 'role_title_required' })
    if (!interviewType) {
      return res.status(400).json({ error: 'invalid_interview_type' })
    }
    if (!jdFile) return res.status(400).json({ error: 'file_required' })

    const originalFilename = String(jdFile.originalname || '').trim()
    const ext = path.extname(originalFilename).toLowerCase()
    if (!['.pdf', '.docx'].includes(ext)) {
      return res.status(400).json({ error: 'invalid_file_type' })
    }
    if (!jdFile.buffer || !jdFile.buffer.length) {
      return res.status(400).json({ error: 'invalid_file' })
    }
    const rawName = path.basename(originalFilename, ext)
    const safeBase = rawName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || `jd-${Date.now()}`
    const safeFilename = `${safeBase}${ext}`
    const contentType =
      ext === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, clientId)
    if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
    const billingClientId = billingScope.billingClientId || clientId

    const { data: billingClient, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,name,email,billing_status,access_override_mode,stripe_customer_id')
      .eq('id', billingClientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!billingClient) return res.status(404).json({ error: 'client_not_found' })

    const accessOverrideMode = String(billingClient.access_override_mode || '').toLowerCase()
    const billingStatus = String(billingClient.billing_status || '').toLowerCase()
    const allowedByBilling =
      accessOverrideMode === 'force_active' ||
      (accessOverrideMode !== 'force_inactive' && billingStatus === 'active')
    if (!allowedByBilling) return res.status(403).json({ error: 'client_inactive' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('plan_tier,billing_interval,per_role_fee')
      .eq('client_id', billingClientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })
    if (!planSettings) return res.status(400).json({ error: 'missing_plan_settings' })

    const perRoleFee = Number(planSettings.per_role_fee)
    if (!Number.isFinite(perRoleFee) || perRoleFee <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }
    const perRoleCents = Math.round(perRoleFee * 100)
    if (!Number.isFinite(perRoleCents) || perRoleCents <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }

    let prepayAttemptJdStoragePath = ''
    const unusedFirstRoleCredit = await findUnusedFirstRolePrepayCredit({
      db: supabaseAdmin,
      billingClientId
    })
    if (unusedFirstRoleCredit?.id) {
      const prepayUploadObjectKey = `pending/${clientId}/first-role-credit-${crypto.randomUUID()}/${safeFilename}`
      const prepayJdUpload = await supabaseAdmin.storage
        .from(ROLE_CHECKOUT_JD_BUCKET)
        .upload(prepayUploadObjectKey, jdFile.buffer, { contentType, upsert: true })
      if (prepayJdUpload.error) {
        return res.status(500).json({ error: 'prepaid_role_jd_upload_failed', detail: prepayJdUpload.error.message })
      }
      prepayAttemptJdStoragePath = `${ROLE_CHECKOUT_JD_BUCKET}/${prepayUploadObjectKey}`

      const prepaidFinalization = await finalizePrepaidRoleCredit({
        db: supabaseAdmin,
        billingClientId,
        clientId,
        roleTitle,
        interviewType,
        jdStoragePath: prepayAttemptJdStoragePath,
        generateRubricAndKBForRole,
        throwOnEnrichmentError: false,
        logger: console
      })
      if (prepaidFinalization.applied) {
        return res.json({
          ok: true,
          credit_applied: true,
          role_id: prepaidFinalization.role_id,
          message: 'First-role prepay credit applied.'
        })
      }
      console.warn('[role-checkout] first_role_prepay_credit_unavailable_after_lookup', {
        billing_client_id: billingClientId,
        client_id: clientId,
        status: prepaidFinalization.status || 'credit_not_available'
      })
    }

    const stripe = require('./lib/stripeClient')

    let stripeCustomerId = String(billingClient.stripe_customer_id || '').trim()
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId)
      } catch (e) {
        const code = String(e?.code || '').toLowerCase()
        const message = String(e?.message || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) {
          stripeCustomerId = ''
        } else {
          throw e
        }
      }
    }
    if (!stripeCustomerId) {
      const email = String(billingClient.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: billingClient.name || undefined,
          email: String(billingClient.email || '').trim() || undefined,
          metadata: {
            client_id: billingClientId,
            billing_client_id: billingClientId,
            scope_client_id: clientId
          }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(billingClient.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingClientId)
        if (saveCustomerError) {
          return res.status(500).json({ error: 'client_update_failed', detail: saveCustomerError.message })
        }
      }
    }

    const { data: pendingRolePurchase, error: pendingRolePurchaseErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .insert({
        client_id: clientId,
        stripe_customer_id: stripeCustomerId || null,
        status: 'pending',
        role_title: roleTitle,
        interview_type: interviewType,
        plan_tier: String(planSettings.plan_tier || '').trim() || null,
        billing_interval: String(planSettings.billing_interval || '').trim() || null
      })
      .select('id')
      .single()
    if (pendingRolePurchaseErr) {
      return res.status(500).json({ error: 'create_pending_role_purchase_failed', detail: pendingRolePurchaseErr.message })
    }

    let pendingJdStoragePath = prepayAttemptJdStoragePath
    if (!pendingJdStoragePath) {
      const pendingJdObjectKey = `pending/${clientId}/${pendingRolePurchase.id}/${safeFilename}`
      const pendingJdUpload = await supabaseAdmin.storage
        .from(ROLE_CHECKOUT_JD_BUCKET)
        .upload(pendingJdObjectKey, jdFile.buffer, { contentType, upsert: true })
      if (pendingJdUpload.error) {
        return res.status(500).json({ error: 'pending_jd_upload_failed', detail: pendingJdUpload.error.message })
      }
      pendingJdStoragePath = `${ROLE_CHECKOUT_JD_BUCKET}/${pendingJdObjectKey}`
    }

    const { error: pendingRolePurchaseJdUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        jd_storage_path: pendingJdStoragePath
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseJdUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseJdUpdateErr.message })
    }

    const sessionMetadata = {
      source: 'client_role_purchase',
      client_id: clientId,
      pending_role_purchase_id: pendingRolePurchase.id,
      role_title: roleTitle,
      interview_type: interviewType,
      plan_tier: String(planSettings.plan_tier || ''),
      billing_interval: String(planSettings.billing_interval || '')
    }
    const rolePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: perRoleCents,
      product_data: { name: 'Role creation fee' },
      metadata: sessionMetadata
    })

    const successParams = new URLSearchParams({
      role_checkout: 'success',
      client_id: String(clientId),
      tab
    })
    const cancelParams = new URLSearchParams({
      role_checkout: 'cancel',
      client_id: String(clientId),
      tab
    })
    if (roleId) {
      successParams.set('role_id', roleId)
      cancelParams.set('role_id', roleId)
    }
    const checkoutBasePayload = {
      mode: 'payment',
      customer: stripeCustomerId,
      line_items: [{ price: rolePrice.id, quantity: 1 }],
      allow_promotion_codes: true,
      metadata: sessionMetadata
    }

    let checkoutClientSecret = null
    let primaryCheckoutSession = null
    let hostedFallbackSession = null

    if (embeddedCheckoutRequested) {
      try {
        primaryCheckoutSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          ui_mode: 'embedded',
          return_url: buildClientDashboardReturnUrl(successParams)
        })
        const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
        if (resolvedClientSecret) {
          checkoutClientSecret = resolvedClientSecret
        } else {
          primaryCheckoutSession = null
        }
      } catch (embeddedErr) {
        console.error('create_role_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
      }
    }

    if (!primaryCheckoutSession) {
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: buildClientDashboardReturnUrl(successParams),
        cancel_url: buildClientDashboardReturnUrl(cancelParams)
      })
    } else {
      try {
        hostedFallbackSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          success_url: buildClientDashboardReturnUrl(successParams),
          cancel_url: buildClientDashboardReturnUrl(cancelParams)
        })
      } catch (hostedFallbackErr) {
        console.error('create_role_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
      }
    }

    const checkoutUrl = String(hostedFallbackSession?.url || primaryCheckoutSession?.url || '').trim() || null
    const checkoutSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim() || null

    const { error: pendingRolePurchaseUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        stripe_checkout_session_id: checkoutSessionId,
        stripe_customer_id: stripeCustomerId || null
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseUpdateErr.message })
    }

    return res.json({
      ok: true,
      url: checkoutUrl,
      session_id: checkoutSessionId,
      checkout_client_secret: checkoutClientSecret,
      embedded_checkout: !!checkoutClientSecret
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_role_checkout_session_failed', detail: e?.message || 'create_role_checkout_session_failed' })
  }
})

const clientMembersScopedRouter = require('./routes/clientMembersScoped')
app.use('/api/client-members', clientMembersScopedRouter)
app.use('/client-members', clientMembersScopedRouter)

app.use('/dashboard', dashboardRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/roles', rolesRouter)
app.use('/api/roles', rolesRouter)
const roleJdReplacementRouter = createRoleJdReplacementRouter()
app.use('/roles', roleJdReplacementRouter)
app.use('/api/roles', roleJdReplacementRouter)
app.use('/automation', automationRouter)
app.use('/api/automation', automationRouter)
app.use('/feedback', require('./routes/feedback'))
app.use('/api/feedback', require('./routes/feedback'))
app.use('/api/alphascreen', require('./routes/alphaScreenPackages'))
app.use('/api/public-analytics', require('./routes/publicAnalytics'))
app.use('/api/public-leads', require('./routes/publicLeads'))

// ---------- Dashboard: scoped rows ----------
async function buildDashboardRows(req, res) {
  try {
    const filterIds = req.clientIds || [];
    if (filterIds.length === 0) return res.json({ items: [] });

    const wantedClientId = req.query.client_id;
    const finalIds = wantedClientId ? filterIds.filter(id => id === wantedClientId) : filterIds;
    if (finalIds.length === 0) return res.json({ items: [] });

    const { data: candRows, error: candErr } = await supabaseAdmin
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, client_id, created_at')
      .in('client_id', finalIds)
      .order('created_at', { ascending: false });

    if (candErr) return res.status(500).json({ error: 'Failed to load candidates', detail: candErr.message });

    const candidateIds = Array.from(new Set((candRows || []).map(c => c.id)));
    const roleIds = Array.from(new Set((candRows || []).map(c => c.role_id).filter(Boolean)));

    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: roleErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds);
      if (!roleErr && roles) {
        rolesById = Object.fromEntries(
          roles.map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    let latestInterviewByCand = {};
    if (candidateIds.length) {
      const { data: ivs, error: intErr } = await supabaseAdmin
        .from('interviews')
        .select('id, candidate_id, client_id, role_id, created_at, video_url, transcript_url, analysis_url')
        .in('candidate_id', candidateIds)
        .in('client_id', finalIds)
        .order('created_at', { ascending: false });

      if (!intErr && ivs) {
        for (const r of ivs) {
          const cid = r.candidate_id;
          if (!latestInterviewByCand[cid]) latestInterviewByCand[cid] = r;
        }
      }
    }

    let bestReportByCand = {};
    if (candidateIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('reports')
        .select(`
          id, candidate_id, role_id,
          resume_score, interview_score, overall_score,
          resume_breakdown, interview_breakdown, analysis,
          report_url, created_at
        `)
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });

      if (reps) {
        for (const rep of reps) {
          const cur = bestReportByCand[rep.candidate_id];
          if (!cur) {
            bestReportByCand[rep.candidate_id] = rep;
          } else {
            const candRole = (candRows.find(c => c.id === rep.candidate_id) || {}).role_id;
            const curMatch = cur?.role_id && candRole && cur.role_id === candRole;
            const newMatch = rep?.role_id && candRole && rep.role_id === candRole;
            if (!curMatch && newMatch) bestReportByCand[rep.candidate_id] = rep;
          }
        }
      }
    }

    const numOrNull = v => (typeof v === 'number' && isFinite(v)) ? v : (v === 0 ? 0 : null);

    const items = (candRows || []).map(c => {
      const fullName =
        c.name ||
        [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
        '';

      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const latest = latestInterviewByCand[c.id] || null;
      const rep = bestReportByCand[c.id] || null;

      const rb = rep?.resume_breakdown || {};
      const ib = rep?.interview_breakdown || {};

      // Prefer summary from interview_breakdown.summary; fall back to reports.analysis
      const interview_summary =
        (typeof ib.summary === 'string' && ib.summary.trim())
          ? ib.summary.trim()
          : (
              typeof rep?.analysis === 'string'
                ? rep.analysis
                : (typeof rep?.analysis?.summary === 'string' ? rep.analysis.summary : '')
            );

      const resume_analysis = {
        experience: numOrNull(rb.experience_match_percent ?? rb.experience),
        skills:     numOrNull(rb.skills_match_percent ?? rb.skills),
        education:  numOrNull(rb.education_match_percent ?? rb.education),
        summary:    typeof rb.summary === 'string' ? rb.summary : ''
      };

      const interview_analysis = {
        clarity:       numOrNull(ib.clarity),
        confidence:    numOrNull(ib.confidence),
        body_language: numOrNull(ib.body_language),
        summary:       typeof interview_summary === 'string' ? interview_summary : ''
      };

      return {
        id: latest?.id ?? null,
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role,

        video_url: latest?.video_url || null,
        transcript_url: latest?.transcript_url || null,
        analysis_url: latest?.analysis_url || null,

        has_video: !!latest?.video_url,
        has_transcript: !!latest?.transcript_url,
        has_analysis: !!latest?.analysis_url,

        resume_score:    numOrNull(rep?.resume_score ?? null),
        interview_score: numOrNull(rep?.interview_score ?? null),
        overall_score:   numOrNull(rep?.overall_score ?? null),

        resume_analysis,
        interview_analysis,

        latest_report_url: rep?.report_url ?? null,
        report_generated_at: rep?.created_at ?? null
      };
    });

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}

// Existing path (kept for compatibility)
app.get('/dashboard/interviews', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// New path used by the FE
app.get('/dashboard/rows', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// ---------- Optional: invites ----------
app.post('/clients/invite', requireAuth, withClientScope, async (req, res) => {
  try {
    const { email, role = 'member', client_id } = req.body || {}
    if (!email || !client_id) return res.status(400).json({ error: 'email and client_id are required' })
    if (!(req.clientIds || []).includes(client_id)) return res.status(403).json({ error: 'Forbidden' })
    if (!hasClientWriteAccess(req, client_id)) return res.status(403).json({ error: 'Forbidden' })

    const token = crypto.randomBytes(16).toString('hex')
    const { error } = await supabaseAdmin
      .from('client_invites')
      .insert({ client_id, email, role, token, invited_by: req.user.id })
    if (error) return res.status(500).json({ error: 'Failed to create invite', detail: error.message })

    const accept_url = buildAcceptInviteUrl(token)
    res.json({ ok: true, accept_url })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/clients/accept-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token is required' })

    const { data: invite, error: invErr } = await supabaseAdmin
      .from('client_invites')
      .select('client_id, email, role')
      .eq('token', token)
      .single()
    if (invErr || !invite) return res.status(400).json({ error: 'Invalid invite', detail: invErr?.message })
    if (invite.email && invite.email !== req.user.email) {
      return res.status(400).json({ error: 'Invite email does not match your account' })
    }

    const { error } = await supabaseAdmin
      .from('client_members')
      .upsert({ client_id: invite.client_id, user_id: req.user.id, role: invite.role }, { onConflict: 'client_id,user_id' })
    if (error) return res.status(500).json({ error: 'Failed to join client', detail: error.message })

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

/* ========================= Admin guard + Admin API (with JD→Rubric→KB) ========================= */

// Admin-only guard (after requireAuth)
async function requireAdmin(req, res, next) {
  try {
    const email = req.user?.email || null
    if (!email) return res.status(403).json({ error: 'not_admin' })

    const { data: adm, error } = await supabaseAdmin
      .from('admins')
      .select('id,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      console.error('admin_lookup_failed:', error.message)
      return res.status(500).json({ error: 'admin_lookup_failed', detail: error.message })
    }
    if (!adm) return res.status(403).json({ error: 'not_admin' })
    next()
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed' })
  }
}

const adminRouter = express.Router()
// Candidate replacement authorization is deliberately separate from the
// legacy candidate CRUD handlers: it is admin-only, client/role-bound, and
// writes an immutable reset event through the Phase B RPC.
adminRouter.use('/interview-recovery', requireAuth, requireAdmin, createInterviewRecoveryRouter())
adminRouter.use('/interview-reliability', requireAuth, requireAdmin, createAdminInterviewReliabilityRouter())
adminRouter.use('/sms-monitoring', requireAuth, requireAdmin, createAdminSmsMonitoringRouter())
const PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH = path.join(__dirname, 'templates', 'pdf', 'alphascreen-public-purchase-support-playbook.pdf')

// Helper: ensure a user exists/invite; return user_id + optional action_link
async function ensureUserIdAndInvite(email, redirectTo, opts = {}) {
  const suppressInvite = opts?.suppressInvite === true
  let userId = null
  let actionLink = null
  let method = null

  if (!suppressInvite) {
    try {
      const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
      userId = invited?.data?.user?.id || null
      method = 'invite'
    } catch (e) {
      console.error('inviteUserByEmail failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo }
      })
      userId = link?.data?.user?.id || null
      actionLink = link?.data?.action_link || null
      method = method || 'magiclink'
    } catch (e) {
      console.error('generateLink(magiclink) failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true
      })
      userId = created?.data?.user?.id || null
      method = method || 'createUser'
    } catch (e) {
      console.error('createUser failed:', e?.message || e)
    }
    if (userId && !suppressInvite) {
      try {
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
        method = 'createUser+invite'
      } catch (e) {
        console.error('second invite after createUser failed:', e?.message || e)
      }
    }
  }

  return { userId, actionLink, method }
}

async function ensureUserIdAndRecoveryLink(email, redirectTo, opts = {}) {
  const requireActionLink = opts?.requireActionLink === true
  const normalizedEmail = String(email || '').trim()
  const emailLower = normalizedEmail.toLowerCase()

  let userId = null
  let actionLink = null
  let method = null
  let lastErr = null

  const findUserId = async () => {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email: normalizedEmail })
      if (error) {
        console.error('listUsers(recovery) failed:', error?.message || error)
        return null
      }
      const existing = (data?.users || []).find((u) => String(u?.email || '').trim().toLowerCase() === emailLower)
      return existing?.id || null
    } catch (e) {
      console.error('listUsers(recovery) exception:', e?.message || e)
      return null
    }
  }

  const generateRecoveryLink = async () => {
    const link = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo }
    })
    return {
      userId: link?.data?.user?.id || null,
      actionLink: link?.data?.action_link || link?.data?.properties?.action_link || null
    }
  }

  try {
    const generated = await generateRecoveryLink()
    userId = generated.userId || userId
    actionLink = generated.actionLink || actionLink
    method = 'recovery'
  } catch (e) {
    lastErr = e
    console.error('generateLink(recovery) failed:', e?.message || e)
  }

  if (!userId) {
    userId = await findUserId()
    if (userId && !method) method = 'existingUser'
  }

  if (!actionLink) {
    if (!userId) {
      try {
        const created = await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          email_confirm: true
        })
        userId = created?.data?.user?.id || userId
        method = method || 'createUser'
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          const err = new Error('create_user_failed')
          err.code = 'create_user_failed'
          err.detail = e?.message || 'create_user_failed'
          err.status = e?.status || e?.response?.status || null
          throw err
        }
      }
      if (!userId) {
        userId = await findUserId()
      }
    }

    try {
      const retry = await generateRecoveryLink()
      userId = retry.userId || userId
      actionLink = retry.actionLink || actionLink
      method = userId ? 'recovery_retry' : method
    } catch (e) {
      lastErr = e
      console.error('generateLink(recovery) retry failed:', e?.message || e)
    }
  }

  if (!userId) {
    const err = new Error('add_member_no_user_id')
    err.code = 'add_member_no_user_id'
    err.detail = 'Could not create or locate user for this email.'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  if (requireActionLink && !actionLink) {
    const err = new Error('generate_recovery_link_failed')
    err.code = 'generate_recovery_link_failed'
    err.detail = lastErr?.message || 'Failed to generate recovery link'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  return { userId, actionLink, method }
}

function addMonthsToIso(isoString, monthsToAdd = 12) {
  const base = new Date(isoString)
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  next.setUTCMonth(next.getUTCMonth() + monthsToAdd)
  return next.toISOString()
}

async function processContractRenewals(context = {}) {
  const triggerSource = String(context?.triggerSource || 'admin')
  const requestId = context?.requestId || null
  const triggeredByUserId = context?.triggeredByUserId || null
  const triggeredByEmail = context?.triggeredByEmail || null
  const now = new Date()
  const nowMs = now.getTime()
  const startedAt = now.toISOString()
  let runId = null

  try {
    const { data: startedRun, error: startedRunError } = await supabaseAdmin
      .from('contract_processing_runs')
      .insert({
        trigger_source: triggerSource,
        started_at: startedAt,
        request_id: requestId,
        triggered_by_user_id: triggeredByUserId,
        triggered_by_email: triggeredByEmail
      })
      .select('id')
      .maybeSingle()
    if (!startedRunError) {
      runId = startedRun?.id || null
    }
  } catch (_) {}

  try {
    let stripe = null
    try {
      const stripeKey = String(process.env.STRIPE_SECRET_KEY || '')
      if (stripeKey) {
        stripe = require('./lib/stripeClient')
      }
    } catch (_) {}

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,billing_status,manual_active_override,contract_start_at,contract_end_at,auto_renew,cancel_effective_at,stripe_subscription_id,subscription_status,cancel_at_term_end')

    if (error) {
      const e = new Error(error.message || 'process_contracts_failed')
      e.detail = error.message || 'process_contracts_failed'
      throw e
    }

    const summary = {
      scanned: (clients || []).length,
      due: 0,
      renewed: 0,
      deactivated: 0,
      skipped_manual_override: 0,
      skipped_no_action: 0,
      errors: 0
    }
    const items = []

    for (const client of (clients || [])) {
      const oldContractEnd = client?.contract_end_at || null
      if (!oldContractEnd) continue

      const oldEndDate = new Date(oldContractEnd)
      if (Number.isNaN(oldEndDate.getTime())) continue
      if (oldEndDate.getTime() > nowMs) continue

      summary.due += 1

      if (client?.manual_active_override === true) {
        summary.skipped_manual_override += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_manual_override',
          contract_end_at_before: oldContractEnd
        })
        continue
      }

      if (client?.auto_renew === true) {
        const newContractStart = oldEndDate.toISOString()
        const newContractEnd = addMonthsToIso(newContractStart, 12)
        if (!newContractEnd) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: 'invalid_contract_end_at'
          })
          continue
        }

        const { error: renewError } = await supabaseAdmin
          .from('clients')
          .update({
            contract_start_at: newContractStart,
            contract_end_at: newContractEnd
          })
          .eq('id', client.id)

        if (renewError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: renewError.message || 'renew_update_failed'
          })
          continue
        }

        summary.renewed += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'renewed',
          contract_end_at_before: oldContractEnd,
          contract_end_at_after: newContractEnd
        })
        continue
      }

      const localSubStatus = String(client?.subscription_status || '').toLowerCase()
      const stripeAlignmentNeeded =
        !!client?.stripe_subscription_id &&
        (localSubStatus === 'active' || localSubStatus === 'trialing') &&
        client?.cancel_at_term_end !== true
      const alreadyInactiveProcessed =
        String(client?.billing_status || '').toLowerCase() === 'inactive' &&
        !!client?.cancel_effective_at

      if (alreadyInactiveProcessed && !stripeAlignmentNeeded) {
        summary.skipped_no_action += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_no_action',
          contract_end_at_before: oldContractEnd,
          detail: 'already_inactive'
        })
        continue
      }

      if (!alreadyInactiveProcessed) {
        const cancelEffectiveAt = oldEndDate.toISOString()
        const { error: deactivateError } = await supabaseAdmin
          .from('clients')
          .update({
            billing_status: 'inactive',
            cancel_effective_at: cancelEffectiveAt
          })
          .eq('id', client.id)

        if (deactivateError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: deactivateError.message || 'deactivate_update_failed'
          })
          continue
        }
      }

      let stripeAlignmentError = null
      let stripeCancelAtTermEnd = false
      if (stripeAlignmentNeeded) {
        if (!stripe) {
          stripeAlignmentError = 'stripe_client_unavailable'
          summary.errors += 1
        } else {
          try {
            await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: true })
            const { error: localStripeFlagError } = await supabaseAdmin
              .from('clients')
              .update({ cancel_at_term_end: true })
              .eq('id', client.id)
            if (localStripeFlagError) {
              stripeAlignmentError = localStripeFlagError.message || 'cancel_at_term_end_update_failed'
              summary.errors += 1
            } else {
              stripeCancelAtTermEnd = true
            }
          } catch (e) {
            stripeAlignmentError = e?.message || 'stripe_cancel_at_period_end_failed'
            summary.errors += 1
          }
        }
      }

      if (alreadyInactiveProcessed) {
        const alignedItem = {
          id: client.id,
          name: client.name || null,
          action: 'aligned_stripe_cancel',
          contract_end_at_before: oldContractEnd
        }
        if (stripeAlignmentError) alignedItem.stripe_alignment_error = stripeAlignmentError
        if (stripeCancelAtTermEnd) alignedItem.stripe_cancel_at_term_end = true
        items.push(alignedItem)
        continue
      }

      summary.deactivated += 1
      const deactivatedItem = {
        id: client.id,
        name: client.name || null,
        action: 'deactivated',
        contract_end_at_before: oldContractEnd,
        billing_status_after: 'inactive'
      }
      if (stripeAlignmentError) deactivatedItem.stripe_alignment_error = stripeAlignmentError
      if (stripeCancelAtTermEnd) deactivatedItem.stripe_cancel_at_term_end = true
      items.push(deactivatedItem)
    }

    const result = { ok: true, summary, items }
    const completedAt = new Date().toISOString()
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}

    return result
  } catch (e) {
    const completedAt = new Date().toISOString()
    const detail = e?.detail || e?.message || 'process_contracts_failed'
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: false,
            error: detail
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: false,
            error: detail,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}
    throw e
  }
}

function trimNullableString(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function buildAdminClientHierarchyMaps(clients) {
  const parentNameById = {}
  const childCountByParentId = {}

  for (const client of clients || []) {
    if (client?.id) parentNameById[client.id] = client.name || null
    const parentId = trimNullableString(client?.parent_client_id)
    if (parentId) childCountByParentId[parentId] = (childCountByParentId[parentId] || 0) + 1
  }

  return { parentNameById, childCountByParentId }
}

function withAdminClientHierarchyMetadata(client, maps = {}) {
  const parentClientId = trimNullableString(client?.parent_client_id)
  const archivedAt = trimNullableString(client?.archived_at)
  return {
    ...client,
    parent_client_id: parentClientId,
    entity_label: trimNullableString(client?.entity_label),
    archived_at: archivedAt,
    archived_reason: trimNullableString(client?.archived_reason),
    archived_by_user_id: trimNullableString(client?.archived_by_user_id),
    archived: !!archivedAt,
    billing_client_id: parentClientId || client?.id || null,
    is_parent_client: !parentClientId,
    is_child_client: !!parentClientId,
    parent_client_name: parentClientId ? (maps.parentNameById?.[parentClientId] || null) : null,
    child_count: client?.id ? (maps.childCountByParentId?.[client.id] || 0) : 0
  }
}

async function loadTopLevelParentClient(parentClientId) {
  const id = trimNullableString(parentClientId)
  if (!id) {
    return {
      ok: false,
      status: 400,
      body: { error: 'parent_client_id_required' }
    }
  }

  const { data: parent, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,parent_client_id,entity_label,candidate_assistance_contact,archived_at')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'parent_client_lookup_failed', detail: error.message }
    }
  }
  if (!parent) {
    return {
      ok: false,
      status: 404,
      body: { error: 'parent_client_not_found' }
    }
  }
  if (trimNullableString(parent.parent_client_id)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_parent_client',
        detail: 'Child entities can only be created under top-level parent clients.'
      }
    }
  }

  return { ok: true, client: parent }
}

function isUnavailableRelationError(error) {
  const code = String(error?.code || '').trim()
  const message = String(error?.message || '').toLowerCase()
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST200' ||
    code === 'PGRST204' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find')
  )
}

async function countClientDeleteBlockers(clientId) {
  const blockers = {}
  const warnings = []
  const checkErrors = []
  const checks = [
    { key: 'child_clients', table: 'clients', column: 'parent_client_id' },
    { key: 'roles', table: 'roles', column: 'client_id' },
    { key: 'candidates', table: 'candidates', column: 'client_id' },
    { key: 'interviews', table: 'interviews', column: 'client_id' },
    { key: 'reports', table: 'reports', column: 'client_id' },
    { key: 'client_members', table: 'client_members', column: 'client_id' },
    { key: 'membership_agreements', table: 'membership_agreements', column: 'client_id' },
    { key: 'client_plan_settings', table: 'client_plan_settings', column: 'client_id' }
  ]

  for (const check of checks) {
    const { count, error } = await supabaseAdmin
      .from(check.table)
      .select('*', { count: 'exact', head: true })
      .eq(check.column, clientId)

    if (error) {
      const checkResult = {
        key: check.key,
        table: check.table,
        column: check.column,
        code: error.code || null,
        detail: error.message || 'delete_blocker_check_failed'
      }
      if (isUnavailableRelationError(error)) {
        warnings.push({ ...checkResult, skipped: true })
      } else {
        checkErrors.push(checkResult)
      }
      continue
    }

    if (Number(count) > 0) blockers[check.key] = Number(count)
  }

  return { blockers, warnings, checkErrors }
}

async function rejectChildClientForAdminBilling(req, res, context) {
  const result = await requireParentClient(supabaseAdmin, req.params?.id, context)
  if (!result.ok) {
    res.status(result.status || 500).json(result.body || { error: 'client_lookup_failed' })
    return null
  }
  return result
}

function sendAdminError(res, status, payload = {}) {
  return res.status(status).json({
    error: payload.error || payload.code || 'server_error',
    code: payload.code || payload.error || 'server_error',
    detail: payload.detail || null,
    hint: payload.hint || null,
    request_id: payload.request_id || null
  })
}

function cleanAdminUserEmail(req) {
  return String(req?.user?.email || '').trim().toLowerCase() || null
}

function normalizeAdminJsonObject(value, fieldName, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    const err = new Error(`${fieldName} must be a JSON object.`)
    err.status = 400
    err.code = `invalid_${fieldName}`
    throw err
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const err = new Error(`${fieldName} must be a JSON object.`)
  err.status = 400
  err.code = `invalid_${fieldName}`
  throw err
}

function automationSchedulerSendEnabled() {
  return ['true', '1', 'yes'].includes(String(process.env.AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED || '').trim().toLowerCase())
}

function automationSchedulerSecretConfigured() {
  return Boolean(String(
    process.env.AUTOMATION_DIGEST_RUNNER_SECRET ||
    process.env.AUTOMATION_DIGEST_CRON_SECRET ||
    process.env.CONTRACTS_CRON_SECRET ||
    ''
  ).trim())
}

function asJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function summarizeKeyValues(value, fallback = 'Default criteria') {
  const source = asJsonObject(value)
  const entries = Object.entries(source)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== '')
    .slice(0, 4)
    .map(([key, entryValue]) => {
      const label = key.replace(/_/g, ' ')
      if (Array.isArray(entryValue)) return `${label}: ${entryValue.length}`
      if (typeof entryValue === 'object') return `${label}: configured`
      return `${label}: ${String(entryValue)}`
    })
  return entries.length ? entries.join(' · ') : fallback
}

function summarizeAutomationRecipients(rule) {
  const digestConfig = asJsonObject(rule?.digest_config)
  const pendingDigest = asJsonObject(digestConfig.pending_approval_digest)
  const actionConfig = asJsonObject(rule?.action_config)
  const recipients = Array.isArray(digestConfig.recipients)
    ? digestConfig.recipients
    : Array.isArray(actionConfig.recipients)
      ? actionConfig.recipients
      : Array.isArray(pendingDigest.recipient_emails)
        ? pendingDigest.recipient_emails
      : []
  if (recipients.length > 0) return `${recipients.length} configured recipient${recipients.length === 1 ? '' : 's'}`
  if (digestConfig.recipient_email || actionConfig.recipient_email) return '1 configured recipient'
  return 'No configured recipients'
}

function summarizeAutomationCadence(rule) {
  const digestConfig = asJsonObject(rule?.digest_config)
  const pendingDigest = asJsonObject(digestConfig.pending_approval_digest)
  const frequency = trimNullableString(pendingDigest.frequency) || trimNullableString(digestConfig.frequency) || trimNullableString(digestConfig.cadence)
  const sendTime = trimNullableString(pendingDigest.send_time_local) || trimNullableString(digestConfig.send_time_local)
  if (frequency && sendTime) return `${frequency} at ${sendTime}`
  return frequency || trimNullableString(rule?.mode) || 'Manual review'
}

function sanitizeAutomationSchedulingUrl(value) {
  const raw = trimNullableString(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    const sensitiveKeys = ['token', 'secret', 'key', 'signature', 'sig', 'auth', 'password', 'code']
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase()
      if (sensitiveKeys.some((sensitive) => lower.includes(sensitive))) {
        url.searchParams.set(key, 'REDACTED')
      }
    }
    url.hash = ''
    return url.toString()
  } catch (_) {
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw
  }
}

function automationRuleStatus(rule) {
  if (trimNullableString(rule?.archived_at)) return 'archived'
  return rule?.enabled === true ? 'active' : 'paused'
}

function maskEmail(value) {
  const email = trimNullableString(value)
  if (!email || !email.includes('@')) return email || null
  const [local, domain] = email.split('@')
  const start = local.slice(0, 1)
  return `${start}${local.length > 1 ? '***' : ''}@${domain}`
}

function deriveAutomationApprovalStatus(action) {
  const state = String(action?.state || '').trim().toLowerCase()
  if (action?.rejected_at || state === 'rejected') return 'rejected'
  if (action?.approved_at || ['approved', 'queued', 'sending', 'sent', 'delivered'].includes(state)) return 'approved'
  if (state === 'pending_approval') return 'pending approval'
  if (state === 'failed') return 'failed'
  if (state === 'canceled') return 'canceled'
  return state || 'unknown'
}

function collectUniqueIds(rows, fields) {
  const ids = new Set()
  for (const row of rows || []) {
    for (const field of fields || []) {
      const id = trimNullableString(row?.[field])
      if (id) ids.add(id)
    }
  }
  return Array.from(ids)
}

async function loadAutomationLookupMap(table, columns, ids) {
  const lookupIds = uniqueClientIds(ids)
  if (!lookupIds.length) return {}
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(columns)
    .in('id', lookupIds)
  if (error) throw error
  return Object.fromEntries((data || []).map((row) => [row.id, row]))
}

async function resolveAdminAutomationClientIds(req, requestId) {
  const clientId = trimNullableString(req.query?.client_id)
  const entityFilter = trimNullableString(req.query?.entity_filter)
  if (!clientId || clientId === 'all') return { ok: true, clientIds: null, entityFilter: null }
  if (!entityFilter) return { ok: true, clientIds: [clientId], entityFilter: null }

  const resolved = await resolveEntityFilter({
    db: supabaseAdmin,
    req: { ...req, isGlobalAdmin: true, isAdmin: true },
    clientId,
    entityFilter,
    requestId
  })
  if (!resolved.ok) return resolved
  return {
    ok: true,
    clientIds: resolved.clientIds || [clientId],
    entityFilter: resolved
  }
}

function countRowsByStatus(rows, field = 'state') {
  const counts = {}
  for (const row of rows || []) {
    const status = String(row?.[field] || 'unknown').trim().toLowerCase() || 'unknown'
    counts[status] = (counts[status] || 0) + 1
  }
  return counts
}

// Read-only internal metrics foundation. This route intentionally returns counts
// and sanitized operational summaries, not raw tokens, webhook payloads, or links.
adminRouter.get('/metrics', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminMetricsPayload({
      db: supabaseAdmin,
      req,
      query: req.query || {},
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safeErrorBody(error, request_id)
    console.error('[admin/metrics] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.get('/public-analytics', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminPublicAnalyticsPayload({
      db: supabaseAdmin,
      query: req.query || {},
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.get('/public-purchases', requireAuth, requireAdmin, async (req, res) => {
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

adminRouter.get('/public-purchases/playbook.pdf', requireAuth, requireAdmin, async (_req, res) => {
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

adminRouter.post('/public-purchases/:id/resend-setup-email', requireAuth, requireAdmin, async (req, res) => {
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

adminRouter.post('/public-purchases/:id/resend-welcome-email', requireAuth, requireAdmin, async (req, res) => {
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

adminRouter.post('/public-purchases/:id/resend-agreement-link', requireAuth, requireAdmin, async (req, res) => {
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

adminRouter.post('/public-purchases/:id/resend-checkout-link', requireAuth, requireAdmin, async (req, res) => {
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

adminRouter.get('/public-analytics/leads.csv', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await buildAdminPublicAnalyticsLeadsCsv({
      db: supabaseAdmin,
      query: req.query || {}
    })
    res.setHeader('Content-Type', payload.content_type)
    res.setHeader('Content-Disposition', `attachment; filename="${payload.filename}"`)
    res.setHeader('X-Export-Row-Count', String(payload.row_count))
    res.setHeader('X-Export-Truncated', payload.truncated ? 'true' : 'false')
    return res.status(200).send(payload.csv)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads.csv] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.post('/public-analytics/leads/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await updatePublicLeadCaptureArchiveBatch({
      db: supabaseAdmin,
      leadIds: req.body?.lead_ids,
      archive: true,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || '',
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/bulk-archive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.post('/public-analytics/leads/unarchive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await updatePublicLeadCaptureArchiveBatch({
      db: supabaseAdmin,
      leadIds: req.body?.lead_ids,
      archive: false,
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/bulk-unarchive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.post('/public-analytics/leads/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await archivePublicLeadCapture({
      db: supabaseAdmin,
      leadId: req.params.id,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || '',
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/archive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

adminRouter.post('/public-analytics/leads/:id/unarchive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const payload = await unarchivePublicLeadCapture({
      db: supabaseAdmin,
      leadId: req.params.id,
      requestId: request_id
    })
    return res.json(payload)
  } catch (error) {
    const body = safePublicAnalyticsErrorBody(error, request_id)
    console.error('[admin/public-analytics/leads/unarchive] failed', {
      request_id,
      code: body.code,
      detail: body.detail
    })
    return sendAdminError(res, error?.status || 500, body)
  }
})

async function loadAdminAutomationRule(ruleId) {
  const id = trimNullableString(ruleId)
  if (!id) return null
  const { data, error } = await supabaseAdmin
    .from('automation_rules')
    .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function updateAdminAutomationRule(req, res, ruleId, updates, successCode = 'ok') {
  const request_id = req.request_id || null
  try {
    const rule = await loadAdminAutomationRule(ruleId)
    if (!rule) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    const payload = {
      ...updates,
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanAdminUserEmail(req),
      updated_at: new Date().toISOString()
    }

    const { data, error } = await supabaseAdmin
      .from('automation_rules')
      .update(payload)
      .eq('id', rule.id)
      .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
      .maybeSingle()

    if (error) {
      return sendAdminError(res, 500, {
        error: 'automation_rule_update_failed',
        code: 'automation_rule_update_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      })
    }
    if (!data) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    return res.json({ ok: true, code: successCode, item: data, request_id })
  } catch (e) {
    console.error('[admin/automation/rules/update] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, e?.status || 500, {
      error: e?.code || 'automation_rule_update_failed',
      code: e?.code || 'automation_rule_update_failed',
      detail: e?.message || null,
      request_id
    })
  }
}

// Read-only platform automation visibility. Do not add send/approve/reject controls here.
adminRouter.get('/automation/overview', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const scopeResult = await resolveAdminAutomationClientIds(req, request_id)
    if (!scopeResult.ok) return res.status(scopeResult.status).json(scopeResult.body)
    const scopedClientIds = Array.isArray(scopeResult.clientIds) ? scopeResult.clientIds : null
    const ruleStatusFilter = trimNullableString(req.query?.rule_status) || 'active'
    const itemStatusFilter = trimNullableString(req.query?.status)

    if (ruleStatusFilter && !['active', 'paused', 'archived', 'all'].includes(ruleStatusFilter)) {
      return sendAdminError(res, 400, {
        error: 'invalid_rule_status',
        code: 'invalid_rule_status',
        detail: 'rule_status must be active, paused, archived, or all.',
        request_id
      })
    }

    let rulesQuery = supabaseAdmin
      .from('automation_rules')
      .select('id,name,client_id,role_id,enabled,mode,criteria_config,action_config,digest_config,rule_version,archived_at,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(500)
    let actionsQuery = supabaseAdmin
      .from('automation_actions')
      .select('id,evaluation_id,rule_id,rule_version,client_id,role_id,candidate_id,report_id,interview_id,action_type,state,approved_by_email,approved_at,rejected_at,canceled_at,sent_at,failed_at,last_error,send_attempt_count,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(500)
    let digestsQuery = supabaseAdmin
      .from('automation_digest_deliveries')
      .select('id,client_id,role_id,recipient_email,recipient_email_domain,digest_type,delivery_date,timezone,send_time_local,status,action_count,sent_at,failed_at,last_error,created_by_email,created_at,updated_at')
      .order('created_at', { ascending: false })
      .limit(250)
    let eventsQuery = supabaseAdmin
      .from('automation_action_events')
      .select('id,action_id,client_id,event_type,from_state,to_state,actor_type,actor_email,created_at')
      .order('created_at', { ascending: false })
      .limit(500)

    if (scopedClientIds) {
      if (scopedClientIds.length === 0) {
        return res.json({
          ok: true,
          overview: {
            total_rules: 0,
            enabled_rules: 0,
            disabled_rules: 0,
            pending_approval_count: 0,
            recent_sent_action_count: 0,
            recent_rejected_action_count: 0,
            recent_failed_action_count: 0,
            recent_digest_delivery_count: 0,
            action_state_counts: {},
            digest_status_counts: {},
            scheduler_send_enabled: automationSchedulerSendEnabled(),
            scheduler_secret_configured: automationSchedulerSecretConfigured(),
            scheduler_send_mode: automationSchedulerSendEnabled() ? 'send_enabled' : 'dry_run_guarded',
            digest_frequencies: ['daily', 'weekdays', 'weekly']
          },
          rules: [],
          actions: [],
          digests: [],
          request_id
        })
      }
      rulesQuery = rulesQuery.in('client_id', scopedClientIds)
      actionsQuery = actionsQuery.in('client_id', scopedClientIds)
      digestsQuery = digestsQuery.in('client_id', scopedClientIds)
      eventsQuery = eventsQuery.in('client_id', scopedClientIds)
    }
    if (itemStatusFilter && itemStatusFilter !== 'all') {
      actionsQuery = actionsQuery.eq('state', itemStatusFilter)
      digestsQuery = digestsQuery.eq('status', itemStatusFilter)
    }

    const [
      rulesResult,
      actionsResult,
      digestsResult,
      eventsResult
    ] = await Promise.all([
      rulesQuery,
      actionsQuery,
      digestsQuery,
      eventsQuery
    ])

    const firstError = rulesResult.error || actionsResult.error || digestsResult.error || eventsResult.error
    if (firstError) {
      return sendAdminError(res, 500, {
        error: 'admin_automation_overview_failed',
        code: 'ADMIN_AUTOMATION_OVERVIEW_FAILED',
        detail: firstError.message,
        hint: firstError.hint || null,
        request_id
      })
    }

    const allRules = rulesResult.data || []
    const rules = allRules.filter((rule) => {
      const status = automationRuleStatus(rule)
      if (ruleStatusFilter === 'all') return true
      return status === ruleStatusFilter
    })
    const actions = actionsResult.data || []
    const digests = digestsResult.data || []
    const events = eventsResult.data || []

    const clientIds = collectUniqueIds([...rules, ...actions, ...digests, ...events], ['client_id'])
    const roleIds = collectUniqueIds([...rules, ...actions, ...digests], ['role_id'])
    const candidateIds = collectUniqueIds(actions, ['candidate_id'])

    const [clientMap, roleMap, candidateMap] = await Promise.all([
      loadAutomationLookupMap('clients', 'id,name,parent_client_id,entity_label,archived_at', clientIds),
      loadAutomationLookupMap('roles', 'id,title,client_id,status', roleIds),
      loadAutomationLookupMap('candidates', 'id,name,email,client_id', candidateIds)
    ])

    const latestEventByActionId = {}
    for (const event of events) {
      const actionId = trimNullableString(event?.action_id)
      if (!actionId || latestEventByActionId[actionId]) continue
      latestEventByActionId[actionId] = event
    }

    const activeRules = allRules.filter((rule) => !trimNullableString(rule.archived_at))
    const digestStatusCounts = countRowsByStatus(digests, 'status')
    const actionStateCounts = countRowsByStatus(actions, 'state')
    const overview = {
      total_rules: activeRules.length,
      enabled_rules: activeRules.filter((rule) => rule.enabled === true).length,
      disabled_rules: activeRules.filter((rule) => rule.enabled !== true).length,
      pending_approval_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'pending_approval').length,
      recent_sent_action_count: actions.filter((action) => ['sent', 'delivered'].includes(String(action.state || '').toLowerCase())).length,
      recent_rejected_action_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'rejected' || action.rejected_at).length,
      recent_failed_action_count: actions.filter((action) => String(action.state || '').toLowerCase() === 'failed' || action.failed_at).length,
      recent_digest_delivery_count: digests.length,
      action_state_counts: actionStateCounts,
      digest_status_counts: digestStatusCounts,
      scheduler_send_enabled: automationSchedulerSendEnabled(),
      scheduler_secret_configured: automationSchedulerSecretConfigured(),
      scheduler_send_mode: automationSchedulerSendEnabled() ? 'send_enabled' : 'dry_run_guarded',
      digest_frequencies: ['daily', 'weekdays', 'weekly']
    }

    const safeRules = rules.map((rule) => {
      const client = clientMap[rule.client_id] || null
      const role = roleMap[rule.role_id] || null
      const actionConfig = asJsonObject(rule.action_config)
      const schedulingUrl = sanitizeAutomationSchedulingUrl(actionConfig.second_round_scheduling_url || actionConfig.scheduling_url)
      return {
        id: rule.id,
        name: trimNullableString(rule.name) || 'Automation rule',
        client_id: rule.client_id || null,
        client_name: client?.name || rule.client_id || null,
        entity_id: rule.client_id || null,
        entity_name: client?.name || rule.client_id || null,
        entity_parent_client_id: client?.parent_client_id || null,
        entity_label: client?.entity_label || null,
        role_id: rule.role_id || null,
        role_title: role?.title || rule.role_id || null,
        enabled: rule.enabled === true,
        archived_at: rule.archived_at || null,
        status: automationRuleStatus(rule),
        mode: rule.mode || null,
        criteria_summary: summarizeKeyValues(rule.criteria_config),
        recipients_summary: summarizeAutomationRecipients(rule),
        cadence_summary: summarizeAutomationCadence(rule),
        scheduling_url_configured: Boolean(schedulingUrl),
        scheduling_url_display: schedulingUrl || null,
        criteria_config: asJsonObject(rule.criteria_config),
        rule_version: rule.rule_version || null,
        created_at: rule.created_at || null,
        updated_at: rule.updated_at || null,
      }
    })

    const safeActions = actions.map((action) => {
      const client = clientMap[action.client_id] || null
      const role = roleMap[action.role_id] || null
      const candidate = candidateMap[action.candidate_id] || null
      const event = latestEventByActionId[action.id] || null
      const eventSummary = event
        ? `${event.event_type || 'event'}${event.to_state ? ` to ${event.to_state}` : ''}`
        : 'No recent event'
      return {
        id: action.id,
        client_id: action.client_id || null,
        client_name: client?.name || action.client_id || null,
        role_id: action.role_id || null,
        role_title: role?.title || action.role_id || null,
        candidate_id: action.candidate_id || null,
        candidate_name: candidate?.name || maskEmail(candidate?.email) || action.candidate_id || null,
        action_type: action.action_type || null,
        state: action.state || null,
        approval_status: deriveAutomationApprovalStatus(action),
        send_attempt_count: action.send_attempt_count || 0,
        last_error: action.last_error ? 'Error recorded' : null,
        event_summary: eventSummary,
        event_at: event?.created_at || null,
        created_at: action.created_at || null,
        updated_at: action.updated_at || null,
      }
    })

    const safeDigests = digests.map((digest) => {
      const client = clientMap[digest.client_id] || null
      const role = roleMap[digest.role_id] || null
      return {
        id: digest.id,
        client_id: digest.client_id || null,
        client_name: client?.name || digest.client_id || null,
        role_id: digest.role_id || null,
        role_title: role?.title || digest.role_id || null,
        recipient_summary: maskEmail(digest.recipient_email) || digest.recipient_email_domain || 'Configured recipient',
        recipient_domain: digest.recipient_email_domain || null,
        digest_type: digest.digest_type || null,
        delivery_date: digest.delivery_date || null,
        timezone: digest.timezone || null,
        send_time_local: digest.send_time_local || null,
        status: digest.status || null,
        pending_count: digest.action_count || 0,
        sent_at: digest.sent_at || null,
        failed_at: digest.failed_at || null,
        last_error: digest.last_error ? 'Error recorded' : null,
        created_at: digest.created_at || null,
        updated_at: digest.updated_at || null,
      }
    })

    return res.json({
      ok: true,
      overview,
      rules: safeRules,
      actions: safeActions,
      digests: safeDigests,
      request_id
    })
  } catch (e) {
    console.error('[admin/automation/overview] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, 500, {
      error: 'admin_automation_overview_failed',
      code: 'ADMIN_AUTOMATION_OVERVIEW_FAILED',
      detail: e?.message || null,
      request_id
    })
  }
})

adminRouter.patch('/automation/rules/:ruleId/pause', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(req, res, req.params?.ruleId, { enabled: false }, 'automation_rule_paused')
})

adminRouter.patch('/automation/rules/:ruleId/resume', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(req, res, req.params?.ruleId, { enabled: true }, 'automation_rule_resumed')
})

adminRouter.patch('/automation/rules/:ruleId/archive', requireAuth, requireAdmin, async (req, res) => {
  return updateAdminAutomationRule(
    req,
    res,
    req.params?.ruleId,
    {
      enabled: false,
      archived_at: new Date().toISOString()
    },
    'automation_rule_archived'
  )
})

adminRouter.patch('/automation/rules/:ruleId', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const rule = await loadAdminAutomationRule(req.params?.ruleId)
    if (!rule) {
      return sendAdminError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      })
    }

    const updates = {}
    let configChanged = false
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'criteria_config')) {
      const nextCriteria = normalizeCriteriaConfig(normalizeAdminJsonObject(req.body.criteria_config, 'criteria_config'))
      updates.criteria_config = nextCriteria
      if (stableStringify(nextCriteria) !== stableStringify(rule.criteria_config || {})) configChanged = true
    }

    if (!Object.keys(updates).length) {
      return sendAdminError(res, 400, {
        error: 'no_update_fields',
        code: 'no_update_fields',
        detail: 'Provide criteria_config.',
        request_id
      })
    }
    if (configChanged) {
      updates.rule_version = Math.max(1, Number(rule.rule_version || 1)) + 1
    }

    return updateAdminAutomationRule(req, res, rule.id, updates, 'automation_rule_criteria_updated')
  } catch (e) {
    console.error('[admin/automation/rules/criteria] unexpected', { request_id, error: e?.message || e })
    return sendAdminError(res, e?.status || 500, {
      error: e?.code || 'automation_rule_update_failed',
      code: e?.code || 'automation_rule_update_failed',
      detail: e?.message || null,
      request_id
    })
  }
})

// List all clients
adminRouter.get('/clients', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,client_admin_name,created_at,plan_tier,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact,stripe_customer_id,stripe_subscription_id,subscription_status,current_term_end,cancel_at_term_end,billing_interval,contract_start_at,contract_end_at,auto_renew,parent_client_id,entity_label,archived_at,archived_reason,archived_by_user_id')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_clients_failed', detail: error.message })
  const items = data || []
  const hierarchyMaps = buildAdminClientHierarchyMaps(items)
  const clientIds = items.map((item) => item?.id).filter(Boolean)
  if (!clientIds.length) return res.json({ items })

  const { data: planSettingsRows, error: planSettingsError } = await supabaseAdmin
    .from('client_plan_settings')
    .select('client_id,plan_tier,billing_interval,platform_fee,per_role_fee,included_interviews_per_role,additional_interview_fee,updated_at')
    .in('client_id', clientIds)
    .order('updated_at', { ascending: false })
  if (planSettingsError) return res.status(500).json({ error: 'list_clients_failed', detail: planSettingsError.message })

  const planSettingsByClientId = {}
  for (const row of planSettingsRows || []) {
    const key = row?.client_id
    if (!key || planSettingsByClientId[key]) continue
    planSettingsByClientId[key] = row
  }

  const enrichedItems = items.map((item) => {
    const settings = planSettingsByClientId[item.id] || null
    return {
      ...withAdminClientHierarchyMetadata(item, hierarchyMaps),
      plan_settings_plan_tier: settings?.plan_tier || null,
      plan_settings_billing_interval: settings?.billing_interval || null,
      plan_settings_platform_fee: settings?.platform_fee ?? null,
      plan_settings_per_role_fee: settings?.per_role_fee ?? null,
      plan_settings_included_interviews_per_role: settings?.included_interviews_per_role ?? null,
      plan_settings_additional_interview_fee: settings?.additional_interview_fee ?? null
    }
  })
  res.json({ items: enrichedItems })
})

// Create client (writes email to satisfy NOT NULL)
adminRouter.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const candidateAssistanceContact = (req.body?.candidate_assistance_contact || '').trim()
  const requestedInitialRole = String(req.body?.admin_role || '').trim().toLowerCase()
  const seededMemberRole = ['admin', 'tester', 'member', 'super_admin'].includes(requestedInitialRole)
    ? requestedInitialRole
    : (requestedInitialRole === 'manager' ? 'admin' : 'super_admin')
  const explicitClientEmail = (req.body?.email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })
  if (!candidateAssistanceContact) return res.status(400).json({ error: 'candidate_assistance_contact_required' })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client' })
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({
      name,
      email: emailForClient,
      client_admin_name: adminName || null,
      candidate_assistance_contact: candidateAssistanceContact,
      plan_tier: null,
      billing_interval: null
    })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('create_client_failed:', cErr.message)
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail) {
    const redirectTo = buildClientDashboardReturnUrl({ auth_callback: '1' })
    const { userId, actionLink, method } = await ensureUserIdAndInvite(adminEmail, redirectTo, { suppressInvite: true })

    if (!userId) {
      console.error('seed_member_no_user_id', { email: adminEmail, method })
      return res.json({ item: client, seeded_member: null, note: 'client_created_invite_failed' })
    }

    const payload = {
      client_id: client.id,
      email: adminEmail,
      name: adminName || adminEmail,
      role: seededMemberRole,
      user_id: userId
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single()

    if (insErr) {
      console.error('seed_member_insert_failed:', insErr.message)
    } else {
      seeded_member = { ...inserted, id: inserted.user_id || inserted.email }
    }
  }

  res.json({ item: client, seeded_member })
})

adminRouter.post('/clients/:parentClientId/entities', requireAuth, requireAdmin, async (req, res) => {
  const name = trimNullableString(req.body?.name)
  const entityLabel = trimNullableString(req.body?.entity_label)
  if (!name) return res.status(400).json({ error: 'name_required' })

  const parentResult = await loadTopLevelParentClient(req.params.parentClientId)
  if (!parentResult.ok) return res.status(parentResult.status).json(parentResult.body)
  const parent = parentResult.client

  const { data: created, error } = await supabaseAdmin
    .from('clients')
    .insert({
      name,
      email: parent.email,
      parent_client_id: parent.id,
      entity_label: entityLabel,
      candidate_assistance_contact: parent.candidate_assistance_contact || null
    })
    .select('id,name,email,created_at,parent_client_id,entity_label,candidate_assistance_contact,archived_at,archived_reason,archived_by_user_id')
    .single()

  if (error) return res.status(500).json({ error: 'create_client_entity_failed', detail: error.message, hint: error.hint })

  const hierarchyMaps = buildAdminClientHierarchyMaps([parent, created])
  return res.json({
    ok: true,
    item: withAdminClientHierarchyMetadata(created, hierarchyMaps)
  })
})

adminRouter.patch('/clients/:parentClientId/entities/:entityClientId', requireAuth, requireAdmin, async (req, res) => {
  const parentResult = await loadTopLevelParentClient(req.params.parentClientId)
  if (!parentResult.ok) return res.status(parentResult.status).json(parentResult.body)
  const parent = parentResult.client

  const updates = {}
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
    const name = trimNullableString(req.body?.name)
    if (!name) return res.status(400).json({ error: 'name_required' })
    updates.name = name
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'entity_label')) {
    updates.entity_label = trimNullableString(req.body?.entity_label)
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_update_fields' })

  const { data: entity, error: entityError } = await supabaseAdmin
    .from('clients')
    .select('id,parent_client_id,archived_at')
    .eq('id', req.params.entityClientId)
    .maybeSingle()

  if (entityError) return res.status(500).json({ error: 'client_entity_lookup_failed', detail: entityError.message })
  if (!entity || String(entity.parent_client_id || '') !== String(parent.id)) {
    return res.status(404).json({ error: 'client_entity_not_found' })
  }

  const { data: updated, error } = await supabaseAdmin
    .from('clients')
    .update(updates)
    .eq('id', entity.id)
    .select('id,name,email,created_at,parent_client_id,entity_label,candidate_assistance_contact,archived_at,archived_reason,archived_by_user_id')
    .single()

  if (error) return res.status(500).json({ error: 'update_client_entity_failed', detail: error.message, hint: error.hint })

  const hierarchyMaps = buildAdminClientHierarchyMaps([parent, updated])
  return res.json({
    ok: true,
    item: withAdminClientHierarchyMetadata(updated, hierarchyMaps)
  })
})

adminRouter.patch('/clients/:parentClientId/entities/:entityClientId/archive', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const result = await archiveChildClientEntity({
      db: supabaseAdmin,
      parentClientId: req.params?.parentClientId,
      entityClientId: req.params?.entityClientId,
      actorUserId: req.user?.id || null,
      reason: req.body?.reason || null,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    const hierarchyMaps = buildAdminClientHierarchyMaps([result.parent, result.entity])
    const item = withAdminClientHierarchyMetadata(result.entity, hierarchyMaps)
    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: true,
        archived_at: result.entity?.archived_at || null,
      },
      item,
      request_id
    })
  } catch (e) {
    console.error('[admin/clients/entities/archive] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})

adminRouter.patch('/clients/:parentClientId/entities/:entityClientId/restore', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  try {
    const result = await restoreChildClientEntity({
      db: supabaseAdmin,
      parentClientId: req.params?.parentClientId,
      entityClientId: req.params?.entityClientId,
      requestId: request_id
    })

    if (!result.ok) return res.status(result.status).json(result.body)

    const hierarchyMaps = buildAdminClientHierarchyMaps([result.parent, result.entity])
    const item = withAdminClientHierarchyMetadata(result.entity, hierarchyMaps)
    return res.json({
      ok: true,
      entity: {
        id: result.entity?.id || null,
        name: result.entity?.name || null,
        archived: false,
        archived_at: null,
      },
      item,
      request_id
    })
  } catch (e) {
    console.error('[admin/clients/entities/restore] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      detail: e?.message || null,
      hint: null,
      request_id
    })
  }
})

adminRouter.patch('/clients/:id/auto-renew', requireAuth, requireAdmin, async (req, res) => {
  const autoRenew = req.body?.auto_renew
  if (typeof autoRenew !== 'boolean') {
    return res.status(400).json({ error: 'invalid_auto_renew' })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_auto_renew' })
  if (!parentGuard) return
  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,stripe_subscription_id,subscription_status,auto_renew,cancel_at_term_end,billing_interval')
    .eq('id', req.params.id)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'update_client_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_mutable' })
  }

  const billingInterval = String(client.billing_interval || '').toLowerCase()
  const isMonthly = billingInterval === 'monthly'
  const isAnnual = billingInterval === 'annual'
  if (isAnnual || !isMonthly) {
    try {
      const stripe = require('./lib/stripeClient')
      await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: autoRenew !== true })
    } catch (e) {
      return res.status(500).json({ error: 'update_client_failed', detail: e?.message || 'stripe_update_failed' })
    }
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({
      auto_renew: autoRenew,
      cancel_at_term_end: isMonthly ? false : (autoRenew ? false : true)
    })
    .eq('id', req.params.id)
    .select('id,auto_renew,cancel_at_term_end')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

adminRouter.patch('/clients/:id/access-override', requireAuth, requireAdmin, async (req, res) => {
  const accessOverrideMode = String(req.body?.access_override_mode || '').trim().toLowerCase()
  if (accessOverrideMode !== 'inherit' && accessOverrideMode !== 'force_active' && accessOverrideMode !== 'force_inactive') {
    return res.status(400).json({ error: 'invalid_access_override_mode' })
  }

  const { data: existingClient, error: existingClientError } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle()
  if (existingClientError) return res.status(500).json({ error: 'update_client_failed', detail: existingClientError.message })
  if (!existingClient) return res.status(404).json({ error: 'client_not_found' })

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ access_override_mode: accessOverrideMode })
    .eq('id', req.params.id)
    .select('id,access_override_mode')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

adminRouter.post('/clients/:id/cancel-contract', requireAuth, requireAdmin, async (req, res) => {
  const requestId = req.request_id || null
  const clientId = req.params?.id
  const note = String(req.body?.note || '').trim() || null
  const rawFinalInvoiceAmount = req.body?.final_invoice_amount
  const parsedFinalInvoiceAmount = Number(rawFinalInvoiceAmount)
  const finalInvoiceAmount = Number.isFinite(parsedFinalInvoiceAmount) && parsedFinalInvoiceAmount > 0
    ? parsedFinalInvoiceAmount
    : null
  const nowIso = new Date().toISOString()
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_cancel_contract' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id,stripe_subscription_id,subscription_status,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'cancel_contract_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_cancelable' })
  }

  const { data: startedRun, error: startedRunError } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .insert({
      client_id: client.id,
      client_name: client.name || null,
      triggered_by_user_id: req.user?.id || null,
      triggered_by_email: req.user?.email || null,
      started_at: nowIso,
      status: 'started',
      final_invoice_amount: finalInvoiceAmount,
      stripe_subscription_id: client.stripe_subscription_id,
      note,
      request_id: requestId
    })
    .select('id')
    .maybeSingle()
  if (startedRunError || !startedRun?.id) {
    return res.status(500).json({ error: 'cancel_contract_failed', detail: startedRunError?.message || 'audit_start_failed' })
  }
  const runId = startedRun.id

  const completeRunWithFailure = async (status, detail, extra = {}) => {
    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status,
          error: detail,
          ...extra
        })
        .eq('id', runId)
    } catch (_) {}
  }

  try {
    const stripe = require('./lib/stripeClient')
    let stripeInvoiceId = null

    if (finalInvoiceAmount && finalInvoiceAmount > 0) {
      try {
        let stripeCustomerId = client.stripe_customer_id || null
        if (!stripeCustomerId) {
          const sub = await stripe.subscriptions.retrieve(client.stripe_subscription_id)
          stripeCustomerId = sub?.customer || null
        }
        if (!stripeCustomerId) throw new Error('missing_stripe_customer')

        const amountCents = Math.round(finalInvoiceAmount * 100)
        const createdInvoice = await stripe.invoices.create({
          customer: stripeCustomerId,
          collection_method: 'send_invoice',
          days_until_due: 0,
          auto_advance: false,
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: createdInvoice.id,
          amount: amountCents,
          currency: 'usd',
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoices.finalizeInvoice(createdInvoice.id)
        const sentInvoice = await stripe.invoices.sendInvoice(createdInvoice.id)
        stripeInvoiceId = sentInvoice?.id || createdInvoice?.id || null
      } catch (e) {
        const detail = e?.message || 'invoice_creation_failed'
        await completeRunWithFailure('invoice_failed', detail)
        return res.status(500).json({ error: 'cancel_contract_failed', detail })
      }
    }

    try {
      await stripe.subscriptions.cancel(client.stripe_subscription_id)
    } catch (e) {
      const detail = e?.message || 'stripe_cancel_failed'
      await completeRunWithFailure('stripe_cancel_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    const cancelEffectiveAt = new Date().toISOString()
    const { data: updatedClient, error: updateError } = await supabaseAdmin
      .from('clients')
      .update({
        billing_status: 'inactive',
        auto_renew: false,
        cancel_at_term_end: false,
        cancel_effective_at: cancelEffectiveAt
      })
      .eq('id', client.id)
      .select('id,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
      .maybeSingle()
    if (updateError || !updatedClient) {
      const detail = updateError?.message || 'local_update_failed'
      await completeRunWithFailure('local_update_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status: 'completed',
          stripe_invoice_id: stripeInvoiceId,
          error: null
        })
        .eq('id', runId)
    } catch (_) {}

    return res.json({ ok: true, item: updatedClient })
  } catch (e) {
    const detail = e?.message || 'cancel_contract_failed'
    await completeRunWithFailure('failed', detail)
    return res.status(500).json({ error: 'cancel_contract_failed', detail })
  }
})

adminRouter.post('/contracts/process-renewals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await processContractRenewals({
      triggerSource: 'admin',
      requestId: req.request_id || null,
      triggeredByUserId: req.user?.id || null,
      triggeredByEmail: req.user?.email || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})

adminRouter.get('/audit/contract-processing-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_processing_runs')
    .select('id,trigger_source,started_at,completed_at,processed_ok,summary,error,request_id,triggered_by_email,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_processing_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

adminRouter.get('/audit/email-delivery-events', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('email_delivery_events')
    .select('id,event_at,event_type,email,email_category,category,sg_event_id,sg_message_id,reason,status,response,attempt,is_time_sensitive,alert_sent_at,alert_error,sg_template_id,subject,from_email,created_at')
    .eq('is_problem', true)
    .order('event_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return res.status(500).json({ error: 'list_email_delivery_events_failed', detail: error.message })
  return res.json({ items: data || [] })
})

adminRouter.get('/audit/contract-cancellation-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .select('id,client_id,client_name,triggered_by_email,started_at,completed_at,status,final_invoice_amount,stripe_invoice_id,stripe_subscription_id,note,request_id,error,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_cancellation_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

adminRouter.get('/audit/billing-reconciliation', requireAuth, requireAdmin, async (_req, res) => {
  const nowMs = Date.now()
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,billing_status,manual_active_override,access_override_mode,contract_end_at,auto_renew,subscription_status,cancel_at_term_end,current_term_end')
  if (error) return res.status(500).json({ error: 'list_billing_reconciliation_failed', detail: error.message })

  const items = (data || []).map((client) => {
    const billingStatus = String(client?.billing_status || '').toLowerCase()
    const accessOverrideMode = String(client?.access_override_mode || 'inherit').toLowerCase()
    const subscriptionStatus = String(client?.subscription_status || '').toLowerCase()
    const liveSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing'
    const contractEndMs = client?.contract_end_at ? new Date(client.contract_end_at).getTime() : NaN

    let reason = null
    if (accessOverrideMode === 'force_active' && billingStatus !== 'active') {
      reason = 'force_active_on_inactive_account'
    } else if (accessOverrideMode === 'force_inactive' && billingStatus === 'active') {
      reason = 'force_inactive_on_active_account'
    } else if (accessOverrideMode === 'force_active' && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'force_active_on_expired_contract'
    } else if (billingStatus === 'inactive' && liveSubscription && client?.cancel_at_term_end !== true) {
      reason = 'inactive_without_stripe_cancel'
    } else if (billingStatus === 'active' && client?.manual_active_override !== true && !liveSubscription) {
      reason = 'active_without_live_subscription'
    } else if (client?.cancel_at_term_end === true && !liveSubscription) {
      reason = 'stripe_cancel_flag_without_live_subscription'
    } else if (client?.manual_active_override === true && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'manual_override_on_expired_contract'
    }

    if (!reason) return null
    return {
      id: client.id,
      name: client.name,
      billing_status: client.billing_status,
      manual_active_override: client.manual_active_override,
      access_override_mode: client.access_override_mode,
      contract_end_at: client.contract_end_at,
      auto_renew: client.auto_renew,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      current_term_end: client.current_term_end,
      reason
    }
  }).filter(Boolean)

  return res.json({ items })
})

adminRouter.get('/audit/agreements', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,client_legal_name,status,created_by_user_id,created_by_email,admin_email,sent_at,opened_at,signed_at,signer_ip,created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return res.status(500).json({ error: 'list_agreement_audit_failed', detail: error.message })

  const toTs = (value) => {
    const raw = String(value || '').trim()
    if (!raw) return 0
    const ts = new Date(raw).getTime()
    return Number.isFinite(ts) ? ts : 0
  }

  const items = []
  for (const row of data || []) {
    const base = {
      agreement_id: row?.id || null,
      client_id: row?.client_id || null,
      client_name: row?.client_legal_name || null,
      sent_by_user_id: row?.created_by_user_id || null,
      sent_by_email: row?.created_by_email || null,
      sent_to_email: row?.admin_email || null,
      signer_ip: row?.signer_ip || null,
      status: row?.status || null
    }

    if (row?.sent_at) {
      items.push({
        ...base,
        id: `${row.id}-sent`,
        event_type: 'agreement_sent',
        event_at: row.sent_at
      })
    }
    if (row?.opened_at) {
      items.push({
        ...base,
        id: `${row.id}-opened`,
        event_type: 'agreement_opened',
        event_at: row.opened_at
      })
    }
    if (row?.signed_at) {
      items.push({
        ...base,
        id: `${row.id}-signed`,
        event_type: 'agreement_signed',
        event_at: row.signed_at
      })
    }
  }

  items.sort((a, b) => toTs(b.event_at) - toTs(a.event_at))
  return res.json({ items })
})

adminRouter.post('/clients/:id/billing/checkout-session', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const clientId = req.params?.id
  const billingCycle = String(req.body?.billing_cycle || '')
  const returnTarget = String(req.body?.return_target || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()
  if (!clientId) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'CLIENT_ID_REQUIRED',
      detail: 'Client id is required.',
      hint: null,
      request_id
    })
  }
  if (billingCycle !== 'monthly' && billingCycle !== 'annual') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'INVALID_BILLING_CYCLE',
      detail: 'billing_cycle must be monthly or annual.',
      hint: null,
      request_id
    })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_billing_checkout_session' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,plan_tier,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()

  if (clientError) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'CLIENT_LOOKUP_FAILED',
      detail: clientError.message || 'Failed to load client.',
      hint: clientError.hint || null,
      request_id
    })
  }
  if (!client) {
    return res.status(404).json({
      error: 'not_found',
      code: 'CLIENT_NOT_FOUND',
      detail: 'Client not found.',
      hint: null,
      request_id
    })
  }

  const planTier = String(client.plan_tier || 'basic').toLowerCase()
  if (planTier === 'enterprise') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'ENTERPRISE_CHECKOUT_NOT_CONFIGURED',
      detail: 'Enterprise checkout is not configured.',
      hint: null,
      request_id
    })
  }

  let resolvedPriceId = ''
  if (planTier === 'basic') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
  } else if (planTier === 'pro') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
  }
  if (!resolvedPriceId) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_PRICE_NOT_CONFIGURED',
      detail: `Missing Stripe price configuration for plan_tier=${planTier} billing_cycle=${billingCycle}.`,
      hint: null,
      request_id
    })
  }

  try {
    const stripe = require('./lib/stripeClient')
    let stripeCustomerId = client.stripe_customer_id || null

    if (!stripeCustomerId) {
      const createdCustomer = await stripe.customers.create({
        name: client.name || undefined,
        email: client.email || undefined,
        metadata: { client_id: client.id }
      })
      stripeCustomerId = createdCustomer?.id || null
      if (!stripeCustomerId) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'STRIPE_CUSTOMER_CREATE_FAILED',
          detail: 'Failed to create Stripe customer.',
          hint: null,
          request_id
        })
      }

      const { error: saveCustomerError } = await supabaseAdmin
        .from('clients')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', client.id)
      if (saveCustomerError) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'CLIENT_UPDATE_FAILED',
          detail: saveCustomerError.message || 'Failed to persist Stripe customer.',
          hint: saveCustomerError.hint || null,
          request_id
        })
      }
    }

    const successParams = new URLSearchParams({
      checkout: 'success',
      client_id: String(client.id)
    })
    const cancelParams = new URLSearchParams({
      checkout: 'cancel',
      client_id: String(client.id)
    })
    if (returnTab) {
      successParams.set('tab', returnTab)
      cancelParams.set('tab', returnTab)
    }
    const successUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(successParams)
        : buildAdminDashboardUrl(successParams)
    const cancelUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(cancelParams)
        : buildAdminDashboardUrl(cancelParams)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        client_id: client.id,
        billing_cycle: billingCycle,
        plan_tier: client.plan_tier || 'basic'
      }
    })

    return res.json({ ok: true, url: session.url, session_id: session.id })
  } catch (e) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_CHECKOUT_SESSION_FAILED',
      detail: e?.message || 'Failed to create Stripe checkout session.',
      hint: null,
      request_id
    })
  }
})

adminRouter.post('/clients/:id/subscription-checkout', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const requestedPlanTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const planTier = requestedPlanTier === 'essential' ? 'basic' : requestedPlanTier
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()

  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_subscription_checkout' })
  if (!parentGuard) return

  try {
    const enterpriseFees = planTier === 'enterprise'
      ? {
          platform_fee: req.body?.platform_fee,
          per_role_fee: req.body?.per_role_fee,
          included_interviews_per_role: req.body?.included_interviews_per_role,
          additional_interview_fee: req.body?.additional_interview_fee
        }
      : null

    const { session, client, clientEmail } = await createSubscriptionCheckoutSession({
      clientId,
      planTier,
      billingInterval,
      returnTab,
      metadataSource: 'admin_subscription_checkout',
      enterpriseFees,
      requestContext: {
        forwardedProto: req.headers?.['x-forwarded-proto'],
        forwardedHost: req.headers?.['x-forwarded-host'],
        protocol: req.protocol,
        host: req.get('host')
      }
    })

    let email_sent = false
    let email_error = null
    try {
      const emailResult = await sendSubscriptionCheckoutEmail(
        clientEmail,
        session?.url || '',
        client.client_admin_name || client.name || ''
      )
      email_sent = emailResult?.statusCode === 202
      if (!email_sent && emailResult?.skipped) email_error = 'email_skipped'
    } catch (e) {
      email_error = e?.message || 'email_send_failed'
    }

    return res.json({
      ok: true,
      url: session?.url || null,
      session_id: session?.id || null,
      client_email: clientEmail,
      email_sent,
      email_error
    })
  } catch (e) {
    const status = Number(e?.status) || 500
    const code = String(e?.code || '').trim()
    if (status >= 500 && !code) {
      return res.status(500).json({ error: 'create_subscription_checkout_failed', detail: e?.message || 'create_subscription_checkout_failed' })
    }
    return res.status(status).json({ error: code || 'create_subscription_checkout_failed', detail: e?.message || 'create_subscription_checkout_failed' })
  }
})

adminRouter.post('/clients/:id/subscription-invoice', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const requestedPlanTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const planTier = requestedPlanTier === 'essential' ? 'basic' : requestedPlanTier
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()

  if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
    return res.status(400).json({ error: 'invalid_plan_tier' })
  }
  if (!['monthly', 'annual'].includes(billingInterval)) {
    return res.status(400).json({ error: 'invalid_billing_interval' })
  }
  const parentGuard = await rejectChildClientForAdminBilling(req, res, { route: 'admin_clients_subscription_invoice' })
  if (!parentGuard) return

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'client_lookup_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,name,primary_contact_email,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) return res.status(500).json({ error: 'customer_lookup_failed', detail: billingCustomerError.message })
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null
  if (!billingCustomer) return res.status(400).json({ error: 'missing_billing_customer' })

  try {
    const stripe = require('./lib/stripeClient')
    const candidateStripeCustomerIds = []
    for (const row of billingCustomerList) {
      const id = String(row?.stripe_customer_id || '').trim()
      if (!id) continue
      if (!candidateStripeCustomerIds.includes(id)) candidateStripeCustomerIds.push(id)
    }
    const fallbackCustomerId = String(client?.stripe_customer_id || '').trim()
    if (fallbackCustomerId && !candidateStripeCustomerIds.includes(fallbackCustomerId)) {
      candidateStripeCustomerIds.push(fallbackCustomerId)
    }

    let resolvedStripeCustomerId = null
    for (const candidateId of candidateStripeCustomerIds) {
      try {
        await stripe.customers.retrieve(candidateId)
        resolvedStripeCustomerId = candidateId
        break
      } catch (e) {
        const message = String(e?.message || '').toLowerCase()
        const code = String(e?.code || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) continue
        throw e
      }
    }
    if (!resolvedStripeCustomerId) return res.status(400).json({ error: 'missing_billing_customer' })
    if (billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
      try {
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: resolvedStripeCustomerId })
          .eq('id', billingCustomer.id)
      } catch (_) {}
    }

    const lineItems = []
    let invoiceTitle = ''
    const invoiceDescription = null
    const daysUntilDue = 7

    if (planTier === 'enterprise') {
      const platformFee = Number(req.body?.platform_fee)
      const perRoleFee = Number(req.body?.per_role_fee)
      if (!Number.isFinite(platformFee) || platformFee < 0 || !Number.isFinite(perRoleFee) || perRoleFee < 0) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      const platformCents = Math.round(platformFee * 100)
      const perRoleCents = Math.round(perRoleFee * 100)
      invoiceTitle = `Enterprise membership (${billingInterval})`
      if (platformCents > 0) lineItems.push({ description: 'Enterprise membership fee', quantity: 1, unit_amount_cents: platformCents })
      if (perRoleCents > 0) lineItems.push({ description: 'Enterprise per-role fee', quantity: 1, unit_amount_cents: perRoleCents })
      if (!lineItems.length) return res.status(400).json({ error: 'invalid_enterprise_fees' })
    } else {
      let priceId = ''
      if (planTier === 'basic') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
      } else if (planTier === 'pro') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
      }
      if (!priceId) return res.status(500).json({ error: 'stripe_price_not_configured' })

      const price = await stripe.prices.retrieve(priceId)
      const unitAmount = Number(price?.unit_amount)
      if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
        return res.status(500).json({ error: 'invalid_price_configuration' })
      }
      const planLabel = planTier === 'basic' ? 'Essential' : 'Pro'
      const intervalLabel = billingInterval === 'annual' ? 'annual' : 'monthly'
      invoiceTitle = `${planLabel} membership (${intervalLabel})`
      lineItems.push({
        description: `${planLabel} membership (${intervalLabel})`,
        quantity: 1,
        unit_amount_cents: unitAmount
      })
    }

    const normalizedItems = lineItems.map((item) => {
      const quantity = Number.isFinite(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1
      const unitAmountCents = Number(item?.unit_amount_cents)
      return {
        description: String(item?.description || '').trim(),
        quantity,
        unit_amount_cents: unitAmountCents,
        line_total_cents: Number.isFinite(unitAmountCents) ? unitAmountCents * quantity : NaN
      }
    })
    if (!normalizedItems.length || normalizedItems.some((item) => !item.description || !Number.isFinite(item.line_total_cents) || item.line_total_cents <= 0)) {
      return res.status(400).json({ error: 'invalid_line_items' })
    }
    const computedSumCents = normalizedItems.reduce((sum, item) => sum + item.line_total_cents, 0)

    const draftInvoice = await stripe.invoices.create({
      customer: resolvedStripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      auto_advance: false,
      description: invoiceDescription || undefined,
      metadata: {
        billing_customer_id: billingCustomer.id,
        client_id: client.id,
        invoice_title: invoiceTitle,
        plan_tier: planTier,
        billing_interval: billingInterval
      }
    })

    for (const item of normalizedItems) {
      await stripe.invoiceItems.create({
        customer: resolvedStripeCustomerId,
        invoice: draftInvoice.id,
        description: item.description,
        amount: item.line_total_cents,
        currency: 'usd'
      })
    }

    const finalized = await stripe.invoices.finalizeInvoice(draftInvoice.id)
    const sent = await stripe.invoices.sendInvoice(finalized.id)
    const invoice = sent || finalized
    let amountTotalCents = computedSumCents
    try {
      const afterSend = await stripe.invoices.retrieve(finalized.id)
      amountTotalCents = Number.isFinite(afterSend?.amount_due)
        ? afterSend.amount_due
        : Number.isFinite(afterSend?.total)
          ? afterSend.total
          : computedSumCents
    } catch (_) {}

    const { data: inserted, error: persistError } = await supabaseAdmin
      .from('billing_invoices')
      .insert({
        billing_customer_id: billingCustomer.id,
        title: invoiceTitle,
        invoice_title: invoiceTitle,
        invoice_description: invoiceDescription,
        amount_total_cents: amountTotalCents,
        currency: 'usd',
        status: invoice?.status || null,
        hosted_invoice_url: invoice?.hosted_invoice_url || null,
        stripe_invoice_id: invoice?.id || null,
        customer_name: billingCustomer.name || null,
        customer_email: billingCustomer.primary_contact_email || null
      })
      .select('id,stripe_invoice_id,status,hosted_invoice_url,invoice_description,amount_total_cents,customer_name,customer_email')
      .single()
    if (persistError) return res.status(500).json({ error: 'persist_failed', detail: persistError.message })

    return res.json({
      ok: true,
      invoice: inserted
    })
  } catch (e) {
    return res.status(500).json({ error: 'send_subscription_invoice_failed', detail: e?.message || 'send_subscription_invoice_failed' })
  }
})

// Delete client
adminRouter.delete('/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  const { blockers, warnings, checkErrors } = await countClientDeleteBlockers(req.params.id)
  if (checkErrors.length > 0) {
    return res.status(500).json({
      error: 'Failed to verify client delete blockers',
      code: 'CLIENT_DELETE_CHECK_FAILED',
      detail: 'One or more related-record checks could not be completed.',
      hint: 'Client was not deleted because related-record checks could not be completed safely.',
      checks: checkErrors
    })
  }

  if (Object.keys(blockers).length > 0) {
    const body = {
      error: 'Cannot delete client with related records',
      code: 'CLIENT_DELETE_BLOCKED',
      detail: 'Delete blocked because this client has related records.',
      hint: 'Remove or reassign related records before deleting this client.',
      blockers
    }
    if (warnings.length) body.warnings = warnings
    return res.status(409).json(body)
  }

  const { error } = await supabaseAdmin.from('clients').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_client_failed', detail: error.message })
  res.json({ ok: true })
})

// List roles (optional client filter)
adminRouter.get('/roles', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const { client_id } = req.query
  const statusFilter = String(req.query.status || 'active').trim().toLowerCase()
  if (!['active', 'inactive', 'all'].includes(statusFilter)) {
    return res.status(400).json({
      error: 'bad_request',
      code: 'INVALID_ROLE_STATUS_FILTER',
      detail: 'status must be active, inactive, or all',
      hint: null,
      request_id
    })
  }
  const entityFilter = req.query.entity_filter || req.query.entity_id || null
  let scopedClientIds = client_id ? [String(client_id).trim()].filter(Boolean) : []
  let entityScope = { entitiesById: {} }
  if (entityFilter) {
    const resolved = await resolveEntityFilter({
      db: supabaseAdmin,
      req,
      clientId: client_id,
      entityFilter,
      requestId: request_id
    })
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
    scopedClientIds = resolved.clientIds
    entityScope = resolved
  }
  let q = supabaseAdmin.from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at,status,closed_at,closed_by,inactive_reason')
    .order('created_at', { ascending: false })
  if (scopedClientIds.length === 1) q = q.eq('client_id', scopedClientIds[0])
  else if (scopedClientIds.length > 1) q = q.in('client_id', scopedClientIds)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: 'list_roles_failed', code: 'LIST_ROLES_FAILED', detail: error.message, hint: error.hint || null, request_id })
  const rows = data || []
  let replacementEligibilityByRoleId = {}
  try {
    replacementEligibilityByRoleId = await getRoleJdReplacementEligibility({ db: supabaseAdmin, roles: rows })
  } catch (eligibilityError) {
    console.error('[admin/roles] replacement eligibility lookup failed', eligibilityError)
    return res.status(500).json({
      error: 'list_role_replacement_eligibility_failed',
      code: 'LIST_ROLE_REPLACEMENT_ELIGIBILITY_FAILED',
      detail: null,
      hint: null,
      request_id
    })
  }
  const entityMap = {
    ...(entityScope.entitiesById || {}),
    ...(await loadEntityMap(supabaseAdmin, rows.map((role) => role.client_id)))
  }
  const availabilityFallback = {
    included_interviews_per_role: null,
    purchased_interviews: null,
    used_interviews: null,
    remaining_interviews: null
  }
  const items = await Promise.all(rows.map(async (rawRole) => {
    const role = normalizeRoleInterviewTypeForRead(rawRole)
    try {
      if (!role?.id || !role?.client_id) {
        return withEntityFields({
          ...role,
          ...availabilityFallback,
          job_description_replacement: replacementEligibilityByRoleId[role?.id] || {
            eligible: false,
            blockers: ['eligibility_unavailable']
          }
        }, entityMap, role?.client_id)
      }
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id
      })
      return withEntityFields({
        ...role,
        included_interviews_per_role: availability?.included_interviews_per_role ?? null,
        purchased_interviews: availability?.purchased_interviews ?? null,
        used_interviews: availability?.used_interviews ?? null,
        remaining_interviews: availability?.remaining_interviews ?? null,
        job_description_replacement: replacementEligibilityByRoleId[role.id] || {
          eligible: false,
          blockers: ['eligibility_unavailable']
        }
      }, entityMap, role.client_id)
    } catch (e) {
      console.warn('[admin/roles] availability lookup failed', {
        role_id: role?.id || null,
        client_id: role?.client_id || null,
        error: e?.message || e
      })
      return withEntityFields({
        ...role,
        ...availabilityFallback,
        job_description_replacement: replacementEligibilityByRoleId[role?.id] || {
          eligible: false,
          blockers: ['eligibility_unavailable']
        }
      }, entityMap, role?.client_id)
    }
  }))
  res.json({ items })
})

// Create role (keeps existing rubric+KB generation)
adminRouter.post('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, title } = req.body || {}
  let { interview_type, job_description_url } = req.body || {}

  if (!client_id || !title || !title.trim()) {
    return res.status(400).json({ error: 'client_id_and_title_required' })
  }
  const interviewTypeRaw = String(interview_type || '').trim()
  interview_type = normalizeInterviewType(interviewTypeRaw, {
    fallback: interviewTypeRaw ? null : 'core'
  })
  if (!interview_type) return res.status(400).json({ error: 'invalid_interview_type' })

  const { data: role, error } = await supabaseAdmin
    .from('roles')
    .insert({
      client_id,
      title: title.trim(),
      interview_type,
      job_description_url: job_description_url || null
    })
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .single()
  if (error) return res.status(500).json({ error: 'create_role_failed', detail: error.message })

  const hasInitialJobDescriptionUrl = typeof role?.job_description_url === 'string' && role.job_description_url.trim().length > 0
  if (hasInitialJobDescriptionUrl) {
    try {
      await generateRubricAndKBForRole(role.id)
    } catch (e) {
      console.error('enrich_role_failed:', e?.message || e)
    }
  }

  const { data: updated } = await supabaseAdmin
    .from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .eq('id', role.id)
    .single()

  res.json({ item: normalizeRoleInterviewTypeForRead(updated || role) })
})

adminRouter.patch('/roles/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = String(req.params.id || '').trim()
    const clientId = String(req.query.client_id || req.body?.client_id || '').trim()
    const status = String(req.body?.status || '').trim().toLowerCase()
    if (!roleId) return res.status(400).json({ error: 'id_required' })
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'INVALID_ROLE_STATUS',
        detail: 'status must be active or inactive'
      })
    }

    let lookup = supabaseAdmin
      .from('roles')
      .select('id,client_id')
      .eq('id', roleId)
    if (clientId) lookup = lookup.eq('client_id', clientId)
    const { data: roleRow, error: lookupErr } = await lookup.maybeSingle()
    if (lookupErr) return res.status(500).json({ error: 'role_lookup_failed', detail: lookupErr.message })
    if (!roleRow) return res.status(404).json({ error: 'not_found' })

    const reason = String(req.body?.inactive_reason || '').trim()
    const patch = status === 'inactive'
      ? {
        status: 'inactive',
        closed_at: new Date().toISOString(),
        closed_by: req.user?.id || null,
        inactive_reason: reason || null
      }
      : {
        status: 'active',
        closed_at: null,
        closed_by: null,
        inactive_reason: null
      }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .update(patch)
      .eq('id', roleId)
      .eq('client_id', roleRow.client_id)
      .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at,status,closed_at,closed_by,inactive_reason')
      .maybeSingle()
    if (error) return res.status(500).json({ error: 'role_status_update_failed', detail: error.message })
    if (!data) return res.status(404).json({ error: 'not_found' })
    return res.json({ item: normalizeRoleInterviewTypeForRead(data) })
  } catch (e) {
    console.error('role_status_update_exception:', e?.message || e)
    return res.status(500).json({ error: 'server_error' })
  }
})

// Delete role by id + client_id (matches FE call shape)
adminRouter.delete('/roles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Alternate delete endpoint via POST body { id, client_id }
adminRouter.post('/roles/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('post_delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('post_delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// List candidates for admin dashboard (requires client selection)
adminRouter.get('/candidates', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const client_id = String(req.query?.client_id || '').trim();
    const role_id = String(req.query?.role_id || '').trim();
    const entityFilter = req.query?.entity_filter || req.query?.entity_id || null;

    if (!client_id) {
      return res.json({ candidates: [], message: 'Select a client to view candidates.' });
    }

    let scopedClientIds = [client_id];
    let entityScope = { entitiesById: {} };
    if (entityFilter) {
      const resolved = await resolveEntityFilter({
        db: supabaseAdmin,
        req,
        clientId: client_id,
        entityFilter,
        requestId: request_id
      });
      if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
      scopedClientIds = resolved.clientIds;
      entityScope = resolved;
    }

    let cq = supabaseAdmin
      .from('candidates')
      .select('id,created_at,client_id,role_id,name,email,status,interview_status,resume_url,analysis_summary,candidate_id,first_name,last_name')
      .order('created_at', { ascending: false });
    if (scopedClientIds.length === 1) cq = cq.eq('client_id', scopedClientIds[0]);
    else cq = cq.in('client_id', scopedClientIds);

    if (role_id) cq = cq.eq('role_id', role_id);

    const { data: cands, error: cErr } = await cq;
    if (cErr) {
      console.error('[admin/candidates] list failed', {
        request_id,
        client_id,
        role_id: role_id || null,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'LIST_CANDIDATES_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    const candidateIds = Array.from(new Set((cands || []).map(c => c.id).filter(Boolean)));
    const roleIds = uniqueEntityIds((cands || []).map(c => c.role_id));
    const latestReportByCandidateId = {};
    const reportsByCandidateId = {};
    let roleClientById = {};

    if (roleIds.length) {
      let rolesQuery = supabaseAdmin
        .from('roles')
        .select('id,client_id')
        .in('id', roleIds);
      if (scopedClientIds.length === 1) rolesQuery = rolesQuery.eq('client_id', scopedClientIds[0]);
      else rolesQuery = rolesQuery.in('client_id', scopedClientIds);
      const { data: roles, error: rolesError } = await rolesQuery;
      if (rolesError) {
        console.error('[admin/candidates] roles lookup failed', {
          request_id,
          client_id,
          code: rolesError.code,
          message: rolesError.message
        });
      } else {
        roleClientById = Object.fromEntries((roles || []).map((role) => [role.id, role.client_id]));
      }
    }

    if (candidateIds.length) {
      let reportsQuery = supabaseAdmin
        .from('reports')
        .select('candidate_id,interview_id,attempt_number,report_kind,resume_score,interview_score,overall_score,report_url,created_at')
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) reportsQuery = reportsQuery.eq('client_id', scopedClientIds[0]);
      else reportsQuery = reportsQuery.in('client_id', scopedClientIds);

      const { data: reports, error: rErr } = await reportsQuery;

      if (rErr) {
        console.error('[admin/candidates] reports lookup failed', {
          request_id,
          client_id,
          code: rErr.code,
          message: rErr.message
        });
        return res.status(500).json({
          error: 'server_error',
          code: 'LIST_CANDIDATES_FAILED',
          detail: rErr.message,
          hint: rErr.hint || null,
          request_id
        });
      }

      for (const rep of (reports || [])) {
        if (rep?.candidate_id) {
          if (!reportsByCandidateId[rep.candidate_id]) reportsByCandidateId[rep.candidate_id] = [];
          reportsByCandidateId[rep.candidate_id].push(rep);
        }
        if (rep?.candidate_id && !latestReportByCandidateId[rep.candidate_id]) {
          latestReportByCandidateId[rep.candidate_id] = rep;
        }
      }
    }

    // Derive interview_score from latest interview transcript_scores.overall (matches client dashboard behavior)
    const latestInterviewByCandidateId = {};
    const transcriptOverallByCandidateId = {};

    if (candidateIds.length) {
      let interviewsQuery = supabaseAdmin
        .from('interviews')
        .select('id,candidate_id,created_at,attempt_number,replacement_authorization_id,transcript_scores,recording_status,recording_ready_at')
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) interviewsQuery = interviewsQuery.eq('client_id', scopedClientIds[0]);
      else interviewsQuery = interviewsQuery.in('client_id', scopedClientIds);

      const { data: ivs, error: iErr } = await interviewsQuery;

      if (iErr) {
        console.error('[admin/candidates] interviews lookup failed', {
          request_id,
          client_id,
          code: iErr.code,
          message: iErr.message
        });
      } else {
        for (const iv of (ivs || [])) {
          if (iv?.candidate_id && !latestInterviewByCandidateId[iv.candidate_id]) {
            latestInterviewByCandidateId[iv.candidate_id] = iv;
          }
        }

        const clamp0to100Local = (v) => {
          if (!Number.isFinite(Number(v))) return null;
          const n = Number(v);
          return Math.max(0, Math.min(100, n));
        };

        for (const cid of candidateIds) {
          const iv = latestInterviewByCandidateId[cid];
          let ts = iv?.transcript_scores;
          if (typeof ts === 'string' && ts.trim()) {
            try { ts = JSON.parse(ts); } catch (_) { ts = null; }
          }
          const overall = ts && typeof ts === 'object' ? ts.overall : null;
          const clamped = clamp0to100Local(overall);
          if (clamped !== null) transcriptOverallByCandidateId[cid] = clamped;
        }
      }
    }

    const entityMap = {
      ...(entityScope.entitiesById || {}),
      ...(await loadEntityMap(supabaseAdmin, (cands || []).map((candidate) => roleClientById[candidate.role_id] || candidate.client_id)))
    };

    const candidates = (cands || []).map((c) => {
      const latestInterview = latestInterviewByCandidateId[c.id] || null;
      const candidateReports = reportsByCandidateId[c.id] || [];
      const exactAttemptReport = latestInterview
        ? candidateReports.find((report) => report.interview_id === latestInterview.id) || null
        : null;
      const isRecoveryAttempt = Number(latestInterview?.attempt_number || 0) > 1
        || !!latestInterview?.replacement_authorization_id;
      const rep = isRecoveryAttempt ? exactAttemptReport : (latestReportByCandidateId[c.id] || null);
      const resumeSource = candidateReports.find((report) => Number.isFinite(Number(report?.resume_score))) || rep;
      const resume_score = Number.isFinite(Number(resumeSource?.resume_score)) ? Number(resumeSource.resume_score) : null;
      const entityClientId = roleClientById[c.role_id] || c.client_id;
      const entityFields = entityFieldsForClientId(entityMap, entityClientId);

      const transcriptOverall = Object.prototype.hasOwnProperty.call(transcriptOverallByCandidateId, c.id)
        ? transcriptOverallByCandidateId[c.id]
        : null;

      const interview_score = Number.isFinite(Number(transcriptOverall)) ? Number(transcriptOverall) : null;

      const rep_overall = Number.isFinite(Number(rep?.overall_score)) ? Number(rep.overall_score) : null;

      const clamp0to100 = (v) => {
        if (!Number.isFinite(Number(v))) return null;
        const n = Number(v);
        return Math.max(0, Math.min(100, n));
      };

      const resumeClamped = clamp0to100(resume_score);
      const interviewClamped = clamp0to100(interview_score);
      const repOverallClamped = clamp0to100(rep_overall);

      let overall_score = null;
      if (resumeClamped !== null && interviewClamped !== null) {
        overall_score = clamp0to100((resumeClamped + interviewClamped) / 2);
      } else if (interviewClamped !== null) {
        overall_score = interviewClamped;
      } else if (resumeClamped !== null) {
        overall_score = resumeClamped;
      } else if (repOverallClamped !== null) {
        overall_score = repOverallClamped;
      }
      return {
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,
        ...entityFields,
        role_id: c.role_id,
        name: c.name || '',
        email: c.email || '',
        status: c.status || null,
        interview_status: c.interview_status || null,
        resume_url: c.resume_url || null,
        analysis_summary: c.analysis_summary || null,
        candidate_id: c.candidate_id || null,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        resume_score,
        interview_score,
        overall_score,
        latest_interview_id: latestInterview?.id || null,
        recording_status: latestInterview?.recording_status || null,
        recording_ready_at: latestInterview?.recording_ready_at || null,
        latest_report_url: rep?.report_url || null,
        report_generated_at: rep?.created_at || null
      };
    });

    return res.json({
      candidates,
      features: {
        interview_recovery_core: isInterviewRecoveryCoreEnabled(),
        interview_recovery_core_email: isInterviewRecoveryCoreEmailEnabled(),
      },
    });
  } catch (e) {
    console.error('[admin/candidates] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'LIST_CANDIDATES_FAILED',
      detail: e?.message || 'Failed to list candidates',
      hint: null,
      request_id
    });
  }
});

// Generate candidate report from Admin dashboard (mirrors client dashboard /reports/generate)
adminRouter.post('/reports/generate', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const candidate_id = normalizeUuid(req.body?.candidate_id);
    if (candidate_id === null) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'INVALID_CANDIDATE_ID',
        detail: 'candidate_id must be a UUID.',
        hint: null,
        request_id
      });
    }

    const { data: cand, error: cErr } = await supabaseAdmin
      .from('candidates')
      .select('id, client_id')
      .eq('id', candidate_id)
      .maybeSingle();

    if (cErr) {
      console.error('[admin/reports/generate] candidate lookup failed', {
        request_id,
        candidate_id,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'CANDIDATE_LOOKUP_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    if (!cand?.client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found',
        hint: null,
        request_id
      });
    }

    // Provide the same scoped context that /reports/* routes expect.
    req.clientIds = [cand.client_id];
    req.client_memberships = [cand.client_id];
    req.memberships = Array.isArray(req.memberships) && req.memberships.length
      ? req.memberships
      : [{ client_id: cand.client_id, role: 'admin' }];

    let reportsPdfRoutes;
    try {
      reportsPdfRoutes = require('./routes/reportsPdf');
    } catch (e) {
      console.error('[admin/reports/generate] require reportsPdf failed', { request_id, error: e?.message || e });
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_ROUTES_MISSING',
        detail: e?.message || 'Failed to load reportsPdf routes',
        hint: null,
        request_id
      });
    }

    const handler = reportsPdfRoutes && typeof reportsPdfRoutes._handleGenerate === 'function'
      ? reportsPdfRoutes._handleGenerate
      : null;

    if (!handler) {
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_HANDLER_MISSING',
        detail: 'reportsPdfRoutes._handleGenerate is not available',
        hint: null,
        request_id
      });
    }

    return handler(req, res);
  } catch (e) {
    console.error('[admin/reports/generate] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'GENERATE_REPORT_FAILED',
      detail: e?.message || 'Failed to generate report',
      hint: null,
      request_id
    });
  }
});

// Delete candidate by id + client_id (safety guard)
adminRouter.delete('/candidates/:id', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const id = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();

    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data, error } = await supabaseAdmin
      .from('candidates')
      .delete()
      .eq('id', id)
      .eq('client_id', client_id)
      .select('id')
      .maybeSingle();

    if (error) {
      const blockedByDependencies = error.code === '23503';
      console.error('[admin/candidates] delete failed', {
        request_id,
        id,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(blockedByDependencies ? 409 : 500).json({
        error: blockedByDependencies ? 'conflict' : 'server_error',
        code: blockedByDependencies ? 'CANDIDATE_DELETE_BLOCKED' : 'DELETE_CANDIDATE_FAILED',
        detail: error.message,
        hint: blockedByDependencies ? 'Candidate has dependent records; enable DB cascade or remove dependents first.' : (error.hint || null),
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found for provided id/client_id',
        hint: null,
        request_id
      });
    }

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[admin/candidates] delete unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'DELETE_CANDIDATE_FAILED',
      detail: e?.message || 'Failed to delete candidate',
      hint: null,
      request_id
    });
  }
});

// Get editable role config
adminRouter.get('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/config] fetch failed', {
        request_id,
        role_id: roleId,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_ROLE_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found',
        hint: null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        rubric: data.rubric || null,
        manual_questions: data.manual_questions || null,
        job_description_text: data.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch role config',
      hint: null,
      request_id
    });
  }
});

// Update editable role config
adminRouter.patch('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};
    let responseRubricQuestions;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric')) {
      updates.rubric = req.body.rubric;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'manual_questions')) {
      updates.manual_questions = req.body.manual_questions;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide rubric and/or manual_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .single();

    if (updateErr) {
      console.error('[admin/roles/config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        rubric: updated.rubric || null,
        manual_questions: updated.manual_questions || null,
        job_description_text: updated.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to update role config',
      hint: null,
      request_id
    });
  }
});

adminRouter.get('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title,tavus_prompt,rubric_questions,rubric,manual_questions')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/interview-config] fetch failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_INTERVIEW_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data || String(data.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    // --- BEGIN: rubric_questions_out computation ---
    const directQuestions = Array.isArray(data.rubric_questions)
      ? data.rubric_questions
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter(Boolean)
      : [];

    let rubric_questions_out = directQuestions;

    if (!rubric_questions_out.length) {
      const out = [];
      const seen = new Set();
      const add = (value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || seen.has(text)) return;
        seen.add(text);
        out.push(text);
      };

      let parsed = data.rubric;
      if (typeof parsed === 'string' && parsed.trim()) {
        try {
          parsed = JSON.parse(parsed);
        } catch (_) {
          parsed = null;
        }
      }

      const parsedQuestions = parsed && typeof parsed === 'object'
        ? (Array.isArray(parsed?.questions) ? parsed.questions : (Array.isArray(parsed) ? parsed : null))
        : null;

      if (Array.isArray(parsedQuestions) && parsedQuestions.length) {
        for (const item of parsedQuestions) {
          if (typeof item === 'string') {
            add(item);
          } else if (item && typeof item === 'object') {
            if (typeof item.question === 'string') add(item.question);
            else if (typeof item.text === 'string') add(item.text);
            else if (typeof item.prompt === 'string') add(item.prompt);
          }
        }
      }

      if (!out.length && typeof data.manual_questions === 'string' && data.manual_questions.trim()) {
        data.manual_questions
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach(add);
      }

      rubric_questions_out = out;
    }
    // --- END: rubric_questions_out computation ---

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        tavus_prompt: data.tavus_prompt || null,
        rubric_questions: rubric_questions_out
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch interview config',
      hint: null,
      request_id
    });
  }
});

adminRouter.patch('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  let responseRubricQuestions;
  let rubricQuestionsEdited = false;
  let updatedRubricForSync = null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/interview-config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tavus_prompt')) {
      const v = req.body.tavus_prompt;
      if (v !== null && typeof v !== 'string') {
        return res.status(400).json({
          error: 'bad_request',
          code: 'INVALID_TAVUS_PROMPT',
          detail: 'tavus_prompt must be a string or null',
          hint: null,
          request_id
        });
      }
      updates.tavus_prompt = v;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric_questions')) {
      const rq = req.body.rubric_questions;
      responseRubricQuestions = rq;
      if (rq !== null) {
        if (!Array.isArray(rq) || rq.some((q) => typeof q !== 'string')) {
          return res.status(400).json({
            error: 'bad_request',
            code: 'INVALID_RUBRIC_QUESTIONS',
            detail: 'rubric_questions must be null or an array of strings',
            hint: null,
            request_id
          });
        }
        const cleanedQuestions = rq.map((q) => String(q || '').trim()).filter(Boolean);
        const normalizeQuestionKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const closedEndedStartRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b/i;
        const openEndedContinuationRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b[\s,:-]*(please\s+)?(tell me about|walk me through|describe\b|how have you\b|what was your approach to\b|explain\b|share\b|give me an example\b)/i;
        const seenQuestionKeys = new Set();
        for (const question of cleanedQuestions) {
          const key = normalizeQuestionKey(question);
          if (seenQuestionKeys.has(key)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions contains duplicate questions',
              hint: null,
              request_id
            });
          }
          seenQuestionKeys.add(key);
          if (closedEndedStartRe.test(question) && !openEndedContinuationRe.test(question)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions must be open-ended and not yes/no style',
              hint: null,
              request_id
            });
          }
        }
        responseRubricQuestions = cleanedQuestions;
        let parsedRubric = null;
        if (typeof existing?.rubric === 'string' && existing.rubric.trim()) {
          try {
            parsedRubric = JSON.parse(existing.rubric);
          } catch {}
        } else if (existing?.rubric && typeof existing.rubric === 'object') {
          parsedRubric = existing.rubric;
        }

        const normalizeQuestion = (value) => String(value || '').trim().toLowerCase();
        const existingCategoryByQuestion = new Map();
        const existingQuestions = Array.isArray(parsedRubric?.questions) ? parsedRubric.questions : [];
        for (const item of existingQuestions) {
          if (!item || typeof item !== 'object') continue;
          const questionText = normalizeQuestion(item.text || item.question || item.prompt);
          if (!questionText) continue;
          const category = typeof item.category === 'string' && item.category.trim() ? item.category : 'Custom';
          if (!existingCategoryByQuestion.has(questionText)) {
            existingCategoryByQuestion.set(questionText, category);
          }
        }

        const newRubricObject = {
          questions: cleanedQuestions.map((q) => ({
            text: q,
            category: existingCategoryByQuestion.get(normalizeQuestion(q)) || 'Custom'
          }))
        };
        updates.rubric = newRubricObject;
        updates.rubric_questions = newRubricObject.questions;
        rubricQuestionsEdited = true;
        updatedRubricForSync = newRubricObject;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide tavus_prompt and/or rubric_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,tavus_prompt,rubric')
      .single();

    if (updateErr) {
      console.error('[admin/roles/interview-config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    if (rubricQuestionsEdited && updatedRubricForSync) {
      try {
        const { data: roleForKbSync, error: roleForKbSyncErr } = await supabaseAdmin
          .from('roles')
          .select('id,title,kb_document_id')
          .eq('id', roleId)
          .eq('client_id', client_id)
          .maybeSingle();

        if (roleForKbSyncErr) throw roleForKbSyncErr;

        if (roleForKbSync?.kb_document_id) {
          const kbJson = makeKBFromRubric(updatedRubricForSync);
          const kbKey = `${roleForKbSync.kb_document_id}.json`;
          const kbPayload = JSON.stringify(kbJson, null, 2);
          let kbUploadError = null;

          const { error: kbUploadErr } = await supabaseAdmin.storage
            .from('kbs')
            .upload(kbKey, new Blob([kbPayload], { type: 'application/json' }), {
              contentType: 'application/json',
              upsert: true
            });
          kbUploadError = kbUploadErr || null;

          if (kbUploadError) {
            const { error: kbUploadErr2 } = await supabaseAdmin.storage
              .from('kbs')
              .upload(kbKey, Buffer.from(kbPayload), {
                contentType: 'application/json',
                upsert: true
              });
            kbUploadError = kbUploadErr2 || null;
          }

          if (kbUploadError) throw kbUploadError;

          await ensureTavusDocumentForRole(
            { id: roleForKbSync.id, title: roleForKbSync.title, kb_document_id: roleForKbSync.kb_document_id },
            { supabase: supabaseAdmin, rubric: updatedRubricForSync, forceRefresh: true }
          );
        }
      } catch (syncErr) {
        console.error('[admin/roles/interview-config] kb_tavus_sync_failed', {
          request_id,
          role_id: roleId,
          client_id,
          error: syncErr?.message || syncErr
        });
      }
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        tavus_prompt: updated.tavus_prompt || null,
        rubric_questions: responseRubricQuestions === undefined
          ? (() => {
              const questions = Array.isArray(updated?.rubric?.questions) ? updated.rubric.questions : [];
              const out = questions
                .map((item) => {
                  if (!item || typeof item !== 'object') return '';
                  const text = item.text || item.question || item.prompt;
                  return typeof text === 'string' ? text.trim() : '';
                })
                .filter(Boolean);
              return out.length ? out : null;
            })()
          : (Array.isArray(responseRubricQuestions) ? responseRubricQuestions : null)
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to update interview config',
      hint: null,
      request_id
    });
  }
});

// List members for a client (synthetic id)
adminRouter.get('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const { client_id } = req.query
  const entityFilter = req.query?.entity_filter || req.query?.entity_id || null
  if (!client_id) return res.status(400).json({ error: 'client_id_required', code: 'CLIENT_ID_REQUIRED', detail: null, hint: null, request_id })

  let scopedClientIds = [String(client_id).trim()].filter(Boolean)
  let entityScope = { entitiesById: {} }
  if (entityFilter) {
    const resolved = await resolveEntityFilter({
      db: supabaseAdmin,
      req,
      clientId: client_id,
      entityFilter,
      requestId: request_id
    })
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
    scopedClientIds = resolved.clientIds
    entityScope = resolved
  }

  let query = supabaseAdmin
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .order('created_at', { ascending: false })
  if (scopedClientIds.length === 1) query = query.eq('client_id', scopedClientIds[0])
  else query = query.in('client_id', scopedClientIds)

  const { data, error } = await query
  if (error) return res.status(500).json({ error: 'list_members_failed', detail: error.message })

  const entityMap = { ...(entityScope.entitiesById || {}), ...(await loadEntityMap(supabaseAdmin, scopedClientIds)) }
  const items = (data || []).map(m => {
    const baseId = m.user_id || m.email
    return withEntityFields({
      ...m,
      id: baseId,
      row_id: `${m.client_id}:${baseId || m.email || m.created_at || 'member'}`
    }, entityMap, m.client_id)
  })
  res.json({ items })
})

// Add a client member
adminRouter.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, email, name } = req.body || {}
  const role = (req.body?.role || 'member').toLowerCase()
  const request_id = req.request_id || null
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' })

  let userId = null
  let actionLink = null
  let method = null
  try {
    const ensured = await ensureUserIdAndRecoveryLink(email, buildClientPwResetUrl({ origin: 'admin' }), {
      requireActionLink: true
    })
    userId = ensured?.userId || null
    actionLink = ensured?.actionLink || null
    method = ensured?.method || null
  } catch (e) {
    console.error('[admin/client-members] ensure_recovery_failed', {
      request_id,
      error: e?.message || e,
      code: e?.code,
      status: e?.status || null
    })
    if (e?.code === 'add_member_no_user_id') {
      return res.status(400).json({
        error: 'add_member_failed',
        detail: e?.detail || 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id,
        code: e.code
      })
    }
    return res.status(500).json({
      error: 'add_member_failed',
      detail: e?.detail || e?.message || 'add_member_failed',
      request_id,
      code: e?.code || 'add_member_failed',
      helper_status: e?.status || null
    })
  }

  if (!userId) {
    console.error('add_member_no_user_id', { email, method })
    return res.status(400).json({
      error: 'add_member_failed',
      detail: 'Could not create or locate user for this email.',
      hint: 'Try again or send the magic link manually.'
    })
  }

  try {
    const emailResult = await sendMemberRecoveryEmail(email, actionLink, name)
    if (emailResult?.statusCode !== 202) {
      const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
      err.code = 'send_member_recovery_email_failed'
      err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
      throw err
    }
  } catch (e) {
    return res.status(500).json({
      error: 'add_member_failed',
      detail: e?.detail || e?.message || 'add_member_failed',
      request_id,
      code: e?.code || 'add_member_failed'
    })
  }

  const payload = { client_id, email, name, role, user_id: userId }

  const { data, error } = await supabaseAdmin
    .from('client_members')
    .insert(payload)
    .select('client_id,user_id,email,name,role,created_at')
    .single()

  if (error) {
    console.error('add_member_insert_failed:', error.message)
    return res.status(500).json({ error: 'add_member_failed', detail: error.message })
  }

  const m = data
  res.json({ item: { ...m, id: m.user_id || m.email } })
})

adminRouter.post('/client-members/batch', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const normalizeRequiredString = (value) => String(value || '').trim()
  const normalizeRole = (value) => {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    return normalized === 'superadmin' ? 'super_admin' : normalized
  }
  const dedupeClientIds = (values) => {
    const seen = new Set()
    const ids = []
    for (const value of values || []) {
      const clientId = normalizeRequiredString(value)
      if (!clientId || seen.has(clientId)) continue
      seen.add(clientId)
      ids.push(clientId)
    }
    return ids
  }
  const isDuplicateMembershipError = (error) => error?.code === '23505' || error?.code === 'PGRST116'
  const loadExistingMemberClientIds = async ({ clientIds, email, userId = null }) => {
    const existing = new Set()
    const byEmail = supabaseAdmin
      .from('client_members')
      .select('client_id')
      .in('client_id', clientIds)
      .eq('email', email)
    const { data: emailRows, error: emailError } = await byEmail
    if (emailError) throw emailError
    for (const row of emailRows || []) {
      if (row?.client_id) existing.add(String(row.client_id))
    }

    if (userId) {
      const { data: userRows, error: userError } = await supabaseAdmin
        .from('client_members')
        .select('client_id')
        .in('client_id', clientIds)
        .eq('user_id', userId)
      if (userError) throw userError
      for (const row of userRows || []) {
        if (row?.client_id) existing.add(String(row.client_id))
      }
    }

    return existing
  }

  try {
    const clientIds = dedupeClientIds(Array.isArray(req.body?.client_ids) ? req.body.client_ids : [])
    const email = normalizeRequiredString(req.body?.email)
    const name = normalizeRequiredString(req.body?.name)
    const role = normalizeRole(req.body?.role || 'member')

    if (!Array.isArray(req.body?.client_ids) || clientIds.length === 0) {
      return res.status(400).json({ error: 'client_ids_required', request_id })
    }
    if (clientIds.length > 50) {
      return res.status(400).json({
        error: 'too_many_client_ids',
        detail: 'Batch member assignment is limited to 50 client scopes.',
        request_id
      })
    }
    if (!email || !name) {
      return res.status(400).json({ error: 'client_id_email_name_required', request_id })
    }
    if (!['member', 'manager', 'super_admin'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role', request_id })
    }

    const itemByClientId = new Map(clientIds.map((clientId) => [clientId, { client_id: clientId, ok: false, status: 'pending' }]))

    let existingClientIds
    try {
      existingClientIds = await loadExistingMemberClientIds({ clientIds, email })
    } catch (e) {
      return res.status(500).json({
        error: 'existing_members_lookup_failed',
        detail: e?.message || 'existing_members_lookup_failed',
        request_id,
        code: e?.code || 'existing_members_lookup_failed'
      })
    }

    for (const clientId of existingClientIds) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
    }

    const needsUserClientIds = clientIds.filter((clientId) => !existingClientIds.has(clientId))
    if (needsUserClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: false,
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      })
    }

    let userId = null
    let actionLink = null
    let method = null
    try {
      const ensured = await ensureUserIdAndRecoveryLink(email, buildClientPwResetUrl({ origin: 'admin' }), {
        requireActionLink: true
      })
      userId = ensured?.userId || null
      actionLink = ensured?.actionLink || null
      method = ensured?.method || null
    } catch (e) {
      console.error('[admin/client-members/batch] ensure_recovery_failed', {
        request_id,
        error: e?.message || e,
        code: e?.code,
        status: e?.status || null
      })
      if (e?.code === 'add_member_no_user_id') {
        return res.status(400).json({
          error: 'add_member_failed',
          detail: e?.detail || 'Could not create or locate user for this email.',
          hint: 'Try again or send the magic link manually.',
          request_id,
          code: e.code
        })
      }
      return res.status(500).json({
        error: 'add_member_failed',
        detail: e?.detail || e?.message || 'add_member_failed',
        request_id,
        code: e?.code || 'add_member_failed',
        helper_status: e?.status || null
      })
    }

    if (!userId) {
      console.error('[admin/client-members/batch] add_member_no_user_id', { request_id, email, method })
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        request_id
      })
    }

    try {
      existingClientIds = await loadExistingMemberClientIds({ clientIds, email, userId })
    } catch (e) {
      return res.status(500).json({
        error: 'existing_members_lookup_failed',
        detail: e?.message || 'existing_members_lookup_failed',
        request_id,
        code: e?.code || 'existing_members_lookup_failed'
      })
    }

    for (const clientId of existingClientIds) {
      itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
    }

    const insertClientIds = clientIds.filter((clientId) => !existingClientIds.has(clientId))
    if (insertClientIds.length === 0) {
      return res.json({
        ok: true,
        created_user: method === 'createUser',
        email_sent: false,
        items: clientIds.map((clientId) => itemByClientId.get(clientId)),
        request_id
      })
    }

    try {
      const emailResult = await sendMemberRecoveryEmail(email, actionLink, name)
      if (emailResult?.statusCode !== 202) {
        const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
        err.code = 'send_member_recovery_email_failed'
        err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
        throw err
      }
    } catch (e) {
      return res.status(500).json({
        error: 'add_member_failed',
        detail: e?.detail || e?.message || 'add_member_failed',
        request_id,
        code: e?.code || 'add_member_failed'
      })
    }

    for (const clientId of insertClientIds) {
      const payload = { client_id: clientId, email, name, role, user_id: userId }
      const { data, error } = await supabaseAdmin
        .from('client_members')
        .insert(payload)
        .select('client_id,user_id,email,name,role,created_at')
        .single()

      if (error) {
        console.error('[admin/client-members/batch] add_member_insert_failed:', {
          request_id,
          client_id: clientId,
          error: error.message,
          code: error.code,
          hint: error.hint
        })
        if (isDuplicateMembershipError(error)) {
          itemByClientId.set(clientId, { client_id: clientId, ok: false, status: 'already_exists' })
        } else {
          itemByClientId.set(clientId, {
            client_id: clientId,
            ok: false,
            status: 'failed',
            detail: error.message,
            code: error.code || 'add_member_failed'
          })
        }
        continue
      }

      itemByClientId.set(clientId, {
        client_id: clientId,
        ok: true,
        status: 'created',
        item: { ...data, id: data.user_id || data.email }
      })
    }

    return res.json({
      ok: true,
      created_user: method === 'createUser',
      email_sent: true,
      items: clientIds.map((clientId) => itemByClientId.get(clientId)),
      request_id
    })
  } catch (e) {
    console.error('[admin/client-members/batch] unexpected', { request_id, error: e?.message || e })
    return res.status(500).json({
      error: 'server_error',
      detail: e?.message || 'server_error',
      request_id,
      code: e?.code || 'server_error'
    })
  }
})

adminRouter.post('/send-password-reset', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const email = String(req.body?.email || '').trim()
  if (!email) return res.status(400).json({ error: 'email_required', request_id })
  const diagPrefix = '[admin/send-password-reset][diag]'
  const redirectTo = buildClientPwResetUrl({ origin: 'admin' })

  try {
    console.log(`${diagPrefix} start`, {
      request_id,
      email,
      redirectTo
    })

    let ensured = null
    try {
      ensured = await ensureUserIdAndRecoveryLink(email, redirectTo, {
        requireActionLink: true
      })
    } catch (e) {
      console.error(`${diagPrefix} helper_failed`, {
        request_id,
        email,
        redirectTo,
        error: e?.message || e,
        code: e?.code || null,
        status: e?.status || null
      })
      throw e
    }

    const actionLink = ensured?.actionLink || null
    let actionLinkHost = null
    let actionLinkPath = null
    let actionLinkContainsPwreset = false
    let actionLinkContainsRedirectTo = false
    if (actionLink) {
      actionLinkContainsPwreset =
        String(actionLink).includes('/pwreset') ||
        String(actionLink).toLowerCase().includes('%2fpwreset')
      actionLinkContainsRedirectTo =
        String(actionLink).includes('redirect_to=') ||
        String(actionLink).toLowerCase().includes('redirect_to%3d')
      try {
        const parsed = new URL(actionLink)
        actionLinkHost = parsed.host || null
        actionLinkPath = parsed.pathname || null
      } catch (_) {}
    }

    console.log(`${diagPrefix} link_generated`, {
      request_id,
      email,
      redirectTo,
      action_link_present: Boolean(actionLink),
      action_link_host: actionLinkHost,
      action_link_path: actionLinkPath,
      action_link_contains_pwreset: actionLinkContainsPwreset,
      action_link_contains_redirect_to: actionLinkContainsRedirectTo
    })

    try {
      const emailResult = await sendMemberRecoveryEmail(email, actionLink, null)
      if (emailResult?.statusCode !== 202) {
        const err = new Error(emailResult?.skipped ? 'email_skipped' : 'email_send_failed')
        err.code = 'send_member_recovery_email_failed'
        err.detail = emailResult?.skipped ? 'email_skipped' : 'email_send_failed'
        throw err
      }
    } catch (e) {
      console.error(`${diagPrefix} mail_send_failed`, {
        request_id,
        email,
        redirectTo,
        action_link_present: Boolean(actionLink),
        action_link_host: actionLinkHost,
        action_link_path: actionLinkPath,
        error: e?.message || e,
        code: e?.code || null,
        status: e?.status || null
      })
      throw e
    }

    console.log(`${diagPrefix} success`, {
      request_id,
      email,
      redirectTo,
      action_link_host: actionLinkHost,
      action_link_path: actionLinkPath
    })
    return res.json({ ok: true, request_id })
  } catch (e) {
    return res.status(500).json({
      error: 'send_password_reset_failed',
      detail: e?.detail || e?.message || 'send_password_reset_failed',
      request_id,
      code: e?.code || 'send_password_reset_failed',
      helper_error_code: e?.code || null,
      helper_status: e?.status || null
    })
  }
})

// Remove a client member
adminRouter.delete('/client-members/:id', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.id
  const client_id = req.query.client_id || null

  let q = supabaseAdmin.from('client_members').delete()
  if (key.includes('@')) q = q.eq('email', key)
  else q = q.eq('user_id', key)
  if (client_id) q = q.eq('client_id', client_id)

  const { error } = await q
  if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message })
  res.json({ ok: true })
})

// Mount admin sub-routers (Billing + Accommodation Requests)
try {
  adminRouter.use('/billing', requireAuth, requireAdmin, require('./routes/adminBilling'))
} catch (e) {
  console.error('[mount] Failed to load routes/adminBilling:', e?.message || e)
}
try {
  adminRouter.use('/accommodation-requests', requireAuth, requireAdmin, require('./routes/accommodationRequests'))
} catch (_) {}

app.post('/internal/contracts/process-renewals', async (req, res) => {
  const expectedSecret = String(process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const result = await processContractRenewals({
      triggerSource: 'cron',
      requestId: req.request_id || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})

app.post('/internal/otp/cleanup', async (req, res) => {
  const expectedSecret = String(process.env.OTP_CLEANUP_CRON_SECRET || process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const nowIso = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('otp_tokens')
      .delete()
      .or(`used.eq.true,expires_at.lt.${nowIso}`)
      .select('id')

    if (error) {
      return res.status(500).json({ error: 'otp_cleanup_failed', detail: error.message })
    }

    return res.json({
      ok: true,
      deleted_count: Array.isArray(data) ? data.length : 0
    })
  } catch (e) {
    return res.status(500).json({
      error: 'otp_cleanup_failed',
      detail: e?.detail || e?.message || 'otp_cleanup_failed'
    })
  }
})

app.post('/internal/recordings/cleanup', async (req, res) => {
  const expectedSecret = String(process.env.RECORDING_CLEANUP_CRON_SECRET || process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  try {
    const result = await cleanupNoSubstantiveRecordings({ db: supabaseAdmin, logger: console })
    return res.json({
      ok: true,
      scanned: result.scanned,
      deleted: result.deleted,
      skipped: result.skipped,
      failed: result.failed
    })
  } catch (e) {
    console.error('[recording-cleanup] unexpected', { error: e?.message || e })
    return res.status(500).json({
      error: 'recording_cleanup_failed',
      detail: e?.message || 'recording_cleanup_failed'
    })
  }
})

app.get('/checkout/subscription-success', async (req, res) => {
  const makeAccountSuccessUrl = (clientId, tab) => {
    const params = new URLSearchParams({ checkout: 'success' })
    if (clientId) params.set('client_id', clientId)
    if (tab) params.set('tab', tab)
    return buildClientDashboardReturnUrl(params)
  }
  const makePublicCheckoutStatusUrl = (status, clientId = '', extra = {}) => {
    const params = { checkout: 'success', status: status || 'setup_pending' }
    if (clientId) params.client_id = clientId
    if (extra.session_id) params.session_id = extra.session_id
    if (extra.agreement_id) params.agreement_id = extra.agreement_id
    return buildPublicCheckoutSuccessUrl(params)
  }
  const request_id = req.request_id || null
  const fallbackClientId = String(req.query?.client_id || '').trim()
  const fallbackTab = String(req.query?.tab || '').trim().toLowerCase()
  const sessionId = String(req.query?.session_id || '').trim()
  const fallbackUrl = makeAccountSuccessUrl(fallbackClientId, fallbackTab)
  let parsedMetadataSource = ''
  if (!sessionId) {
    console.log('subscription_checkout_success_redirect:', {
      branch: 'missing_session_id',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }

  try {
    const stripe = require('./lib/stripeClient')
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
    const pickStripeId = (value) => {
      if (!value) return null
      if (typeof value === 'string') return value
      if (typeof value === 'object' && typeof value.id === 'string') return value.id
      return null
    }
    const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}
    const metadataSource = String(metadata?.source || '').trim().toLowerCase()
    parsedMetadataSource = metadataSource
    const metadataClientId = String(metadata?.client_id || '').trim()
    const metadataAgreementId = String(metadata?.agreement_id || '').trim()
    const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase()
    const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase()
    const clientId = metadataClientId || fallbackClientId
    const successUrl = makeAccountSuccessUrl(clientId, fallbackTab)
    const agreementStatusUrl = (status) => makePublicCheckoutStatusUrl(status, clientId, {
      session_id: sessionId,
      agreement_id: metadataAgreementId
    })
    const paymentStatus = String(session?.payment_status || '').toLowerCase()
    const subscriptionObj = session?.subscription && typeof session.subscription === 'object' ? session.subscription : null
    const subscriptionMetadata = subscriptionObj?.metadata && typeof subscriptionObj.metadata === 'object' ? subscriptionObj.metadata : {}
    const subscriptionStatus = String(subscriptionObj?.status || '').toLowerCase()
    const replacesStripeSubscriptionId = String(
      metadata?.replaces_stripe_subscription_id ||
      subscriptionMetadata?.replaces_stripe_subscription_id ||
      ''
    ).trim()

    console.log('subscription_checkout_success_entry:', {
      client_id: clientId || null,
      fallback_tab: fallbackTab || null,
      metadata_source: metadataSource || null,
      session_status: String(session?.status || '').toLowerCase() || null,
      session_payment_status: paymentStatus || null,
      subscription_status: subscriptionStatus || null
    })

    if (!['admin_subscription_checkout', 'agreement_checkout'].includes(metadataSource)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'metadata_source_mismatch',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    if (String(session?.status || '').toLowerCase() !== 'complete') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'session_incomplete',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('payment_pending') : successUrl)
    }
    if (paymentStatus && !['paid', 'no_payment_required'].includes(paymentStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'payment_not_paid',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('payment_pending') : successUrl)
    }
    if (subscriptionStatus && !['active', 'trialing'].includes(subscriptionStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'subscription_not_active',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('activation_pending') : successUrl)
    }

    if (metadataSource === 'agreement_checkout') {
      const returnState = await resolvePublicCheckoutReturnState({
        sessionId,
        fallbackClientId: clientId,
        agreementId: metadataAgreementId
      })
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_webhook_state',
        status: returnState?.status || 'setup_pending',
        target: 'public_checkout_status'
      })
      return res.redirect(302, agreementStatusUrl(returnState?.status || 'setup_pending'))
    }

    if (metadataSource === 'agreement_checkout' && metadataAgreementId) {
      try {
        await supabaseAdmin
          .from('membership_agreements')
          .update({
            checkout_status: 'paid',
            checkout_session_id: sessionId,
            checkout_paid_at: new Date().toISOString()
          })
          .eq('id', metadataAgreementId)
      } catch (agreementCheckoutUpdateErr) {
        console.error('subscription_checkout_success_agreement_checkout_state_update_failed:', agreementCheckoutUpdateErr?.message || agreementCheckoutUpdateErr)
      }
    }

    let client = null
    if (clientId) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,name,email,client_admin_name')
        .eq('id', clientId)
        .maybeSingle()
      if (clientErr) throw new Error(clientErr.message || 'client_lookup_failed')
      client = clientRow || null
    }
    console.log('subscription_checkout_success_client_lookup:', {
      client_id: clientId || null,
      found: !!client?.id,
      has_email: !!String(client?.email || '').trim()
    })
    if (!client?.id) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_not_found',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('setup_pending') : successUrl)
    }

    if (subscriptionObj && ['active', 'trialing'].includes(subscriptionStatus)) {
      try {
        const toIsoFromUnixSeconds = (value) => {
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) return null
          return new Date(n * 1000).toISOString()
        }
        const normalizeStripeInterval = (value) => {
          const raw = String(value || '').trim().toLowerCase()
          if (raw === 'month') return 'monthly'
          if (raw === 'year') return 'annual'
          if (raw === 'monthly' || raw === 'annual') return raw
          return null
        }
        const cancelAtTermEnd = subscriptionObj?.cancel_at_period_end === true
        let autoRenewForClient = !cancelAtTermEnd
        if (metadataSource === 'agreement_checkout' && metadataAgreementId) {
          try {
            const { data: agreementRenewal, error: agreementRenewalErr } = await supabaseAdmin
              .from('membership_agreements')
              .select('auto_renew')
              .eq('id', metadataAgreementId)
              .maybeSingle()
            if (agreementRenewalErr) {
              console.error('subscription_checkout_success_agreement_auto_renew_lookup_failed:', {
                request_id,
                agreement_id: metadataAgreementId,
                error: agreementRenewalErr.message,
                code: agreementRenewalErr.code || null,
                hint: agreementRenewalErr.hint || null
              })
            } else if (typeof agreementRenewal?.auto_renew === 'boolean') {
              autoRenewForClient = agreementRenewal.auto_renew
            }
          } catch (agreementRenewalErr) {
            console.error('subscription_checkout_success_agreement_auto_renew_lookup_failed:', {
              request_id,
              agreement_id: metadataAgreementId,
              error: agreementRenewalErr?.message || agreementRenewalErr
            })
          }
        }
        const intervalRaw =
          subscriptionObj?.items?.data?.[0]?.price?.recurring?.interval ||
          subscriptionObj?.plan?.interval ||
          ''
        const clientBillingUpdates = {
          stripe_customer_id: pickStripeId(subscriptionObj?.customer) || pickStripeId(session?.customer) || null,
          stripe_subscription_id: pickStripeId(subscriptionObj?.id) || null,
          subscription_status: subscriptionStatus,
          current_term_end: toIsoFromUnixSeconds(
            subscriptionObj?.current_period_end ??
            subscriptionObj?.items?.data?.[0]?.current_period_end ??
            null
          ),
          cancel_at_term_end: cancelAtTermEnd,
          billing_interval: normalizeStripeInterval(intervalRaw) || normalizeStripeInterval(metadataBillingInterval),
          billing_status: 'active',
          auto_renew: autoRenewForClient,
          cancel_effective_at: null
        }
        if (['basic', 'pro', 'enterprise'].includes(metadataPlanTier)) {
          clientBillingUpdates.plan_tier = metadataPlanTier
        }
        const { error: clientBillingUpdateErr } = await supabaseAdmin
          .from('clients')
          .update(clientBillingUpdates)
          .eq('id', client.id)
        if (clientBillingUpdateErr) {
          console.error('subscription_checkout_success_client_billing_update_failed:', {
            request_id,
            client_id: client.id,
            session_id: sessionId,
            error: clientBillingUpdateErr.message,
            code: clientBillingUpdateErr.code || null,
            hint: clientBillingUpdateErr.hint || null
          })
        }
      } catch (clientBillingUpdateErr) {
        console.error('subscription_checkout_success_client_billing_update_failed:', {
          request_id,
          client_id: client.id,
          session_id: sessionId,
          error: clientBillingUpdateErr?.message || clientBillingUpdateErr
        })
      }
    }

    if (metadataSource === 'agreement_checkout' && metadataAgreementId && replacesStripeSubscriptionId) {
      const newSubscriptionId = pickStripeId(subscriptionObj?.id)
      const currentCustomerId = pickStripeId(subscriptionObj?.customer) || pickStripeId(session?.customer)
      try {
        if (!newSubscriptionId) throw new Error('replacement_new_subscription_missing')
        if (!['active', 'trialing'].includes(subscriptionStatus)) throw new Error('replacement_new_subscription_not_active')
        if (replacesStripeSubscriptionId === newSubscriptionId) throw new Error('replacement_subscription_matches_new_subscription')
        if (!currentCustomerId) throw new Error('replacement_customer_missing')

        const oldSubscription = await stripe.subscriptions.retrieve(replacesStripeSubscriptionId)
        const oldCustomerId = pickStripeId(oldSubscription?.customer)
        if (!oldCustomerId) throw new Error('replacement_old_customer_missing')
        if (oldCustomerId !== currentCustomerId) throw new Error('replacement_customer_mismatch')

        if (String(oldSubscription?.status || '').trim().toLowerCase() !== 'canceled') {
          await stripe.subscriptions.cancel(replacesStripeSubscriptionId, {
            invoice_now: false,
            prorate: false
          })
        }

        const { error: replacementUpdateErr } = await supabaseAdmin
          .from('membership_agreements')
          .update({
            replaced_stripe_subscription_canceled_at: new Date().toISOString(),
            replacement_error: null
          })
          .eq('id', metadataAgreementId)
        if (replacementUpdateErr) throw new Error(replacementUpdateErr.message || 'replacement_state_update_failed')
      } catch (replacementErr) {
        const replacementError = String(replacementErr?.message || replacementErr || 'replacement_cancel_failed').slice(0, 500)
        console.error('subscription_checkout_success_replacement_cancel_failed:', {
          request_id,
          agreement_id: metadataAgreementId,
          client_id: client.id,
          old_subscription_id: replacesStripeSubscriptionId,
          new_subscription_id: newSubscriptionId || null,
          error: replacementError
        })
        try {
          await supabaseAdmin
            .from('membership_agreements')
            .update({ replacement_error: replacementError })
            .eq('id', metadataAgreementId)
        } catch (_) {}
      }
    }

    const clientEmail = String(client.email || '').trim()
    if (!clientEmail) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_email_missing',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('setup_pending') : successUrl)
    }
    const clientEmailLower = clientEmail.toLowerCase()
    const membershipName = String(client.client_admin_name || client.name || clientEmail).trim() || clientEmail

    const upsertClientManagerMembership = async (targetUserId, opts = {}) => {
      const requireUserId = opts?.requireUserId === true
      const normalizedUserId = String(targetUserId || '').trim() || null
      if (requireUserId && !normalizedUserId) throw new Error('membership_user_id_required')
      const { data: existingRows, error: existingErr } = await supabaseAdmin
        .from('client_members')
        .select('client_id,user_id,email,name,role')
        .eq('client_id', client.id)
      if (existingErr) throw new Error(existingErr.message || 'membership_lookup_failed')

      const existingMembership = (existingRows || []).find((row) => {
        return String(row?.email || '').trim().toLowerCase() === clientEmailLower
      }) || null

      if (!existingMembership) {
        const insertPayload = {
          client_id: client.id,
          email: clientEmail,
          name: membershipName,
          role: 'manager'
        }
        if (normalizedUserId) insertPayload.user_id = normalizedUserId

        const { error: insertErr } = await supabaseAdmin
          .from('client_members')
          .insert(insertPayload)
        if (insertErr) throw new Error(insertErr.message || 'membership_insert_failed')
        return
      }

      const updatePayload = {}
      const existingRole = String(existingMembership.role || '').trim().toLowerCase()
      const existingName = String(existingMembership.name || '').trim()
      const existingUserId = String(existingMembership.user_id || '').trim()

      if (existingRole !== 'manager') updatePayload.role = 'manager'
      if (!existingName) updatePayload.name = membershipName
      if (normalizedUserId && existingUserId !== normalizedUserId) updatePayload.user_id = normalizedUserId

      if (!Object.keys(updatePayload).length) return

      const membershipEmail = String(existingMembership.email || '').trim() || clientEmail
      const { error: updateErr } = await supabaseAdmin
        .from('client_members')
        .update(updatePayload)
        .eq('client_id', client.id)
        .eq('email', membershipEmail)
      if (updateErr) throw new Error(updateErr.message || 'membership_update_failed')
    }

    const findAuthUserByClientEmail = async () => {
      try {
        const { data: authUsersData, error: authUsersError } = await supabaseAdmin.auth.admin.listUsers({ email: clientEmail })
        if (authUsersError) {
          console.error('subscription_checkout_list_users_failed:', authUsersError?.message || authUsersError)
          return null
        }
        return (authUsersData?.users || []).find((user) => {
          return String(user?.email || '').trim().toLowerCase() === clientEmailLower
        }) || null
      } catch (listUsersErr) {
        console.error('subscription_checkout_list_users_exception:', listUsersErr?.message || listUsersErr)
        return null
      }
    }

    const findAuthUserById = async (userId) => {
      const normalizedUserId = String(userId || '').trim()
      if (!normalizedUserId) return null
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(normalizedUserId)
        if (error) {
          console.error('subscription_checkout_get_user_by_id_failed:', error?.message || error)
          return null
        }
        return data?.user || null
      } catch (getUserErr) {
        console.error('subscription_checkout_get_user_by_id_exception:', getUserErr?.message || getUserErr)
        return null
      }
    }

    const recoveryRedirectUrl = buildClientPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id
    })

    let existingAuthUser = await findAuthUserByClientEmail()
    let authUserId = String(existingAuthUser?.id || '').trim() || null

    if (metadataSource === 'agreement_checkout' && !authUserId) {
      const ensured = await ensureUserIdAndRecoveryLink(clientEmail, recoveryRedirectUrl, {
        requireActionLink: false
      })
      authUserId = String(ensured?.userId || '').trim() || null
      existingAuthUser = await findAuthUserById(authUserId)
    }

    if (!existingAuthUser && authUserId) {
      existingAuthUser = await findAuthUserById(authUserId)
    }

    await upsertClientManagerMembership(authUserId, {
      requireUserId: metadataSource === 'agreement_checkout'
    })

    const hasSignedIn = !!String(existingAuthUser?.last_sign_in_at || '').trim()
    console.log('subscription_checkout_success_auth_user_lookup:', {
      matching_user_found: !!existingAuthUser,
      has_last_sign_in_at: hasSignedIn
    })
    if (existingAuthUser && hasSignedIn) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'existing_user_signed_in',
        target: metadataSource === 'agreement_checkout' ? 'public_checkout_status' : 'success_url'
      })
      return res.redirect(302, metadataSource === 'agreement_checkout' ? agreementStatusUrl('ready') : successUrl)
    }

    const generateRecoveryActionLink = async () => {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: clientEmail,
        options: { redirectTo: recoveryRedirectUrl }
      })
      return link?.data?.action_link || link?.data?.properties?.action_link || null
    }

    let recoveryActionLink = null
    let createUserAttempted = false
    let retryProducedActionLink = false
    try {
      recoveryActionLink = await generateRecoveryActionLink()
    } catch (recoveryErr) {
      console.error('subscription_checkout_generate_recovery_link_failed:', recoveryErr?.message || recoveryErr)
    }
    console.log('subscription_checkout_success_recovery_first_result:', {
      has_action_link: !!recoveryActionLink
    })

    if (!recoveryActionLink) {
      createUserAttempted = true
      try {
        const createdUser = await supabaseAdmin.auth.admin.createUser({
          email: clientEmail,
          email_confirm: true
        })
        const createdUserId = String(createdUser?.data?.user?.id || '').trim()
        if (createdUserId) authUserId = createdUserId
      } catch (createErr) {
        const msg = String(createErr?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          console.error('subscription_checkout_create_user_failed:', createErr?.message || createErr)
        }
      }
      try {
        recoveryActionLink = await generateRecoveryActionLink()
        retryProducedActionLink = !!recoveryActionLink
      } catch (recoveryRetryErr) {
        console.error('subscription_checkout_generate_recovery_link_retry_failed:', recoveryRetryErr?.message || recoveryRetryErr)
      }
    }

    if (!authUserId) {
      const refreshedAuthUser = await findAuthUserByClientEmail()
      if (refreshedAuthUser) {
        existingAuthUser = refreshedAuthUser
        authUserId = String(refreshedAuthUser.id || '').trim() || null
      }
    }

    if (!authUserId && metadataSource === 'agreement_checkout') {
      throw new Error('agreement_checkout_auth_user_missing_after_bootstrap')
    }

    if (!existingAuthUser && authUserId) {
      existingAuthUser = await findAuthUserById(authUserId)
    }

    await upsertClientManagerMembership(authUserId, {
      requireUserId: metadataSource === 'agreement_checkout'
    })

    console.log('subscription_checkout_success_create_user_attempt:', {
      attempted: createUserAttempted
    })
    if (createUserAttempted) {
      console.log('subscription_checkout_success_recovery_retry_result:', {
        has_action_link: retryProducedActionLink
      })
    }

    if (recoveryActionLink) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'recovery_action_link',
        target: 'recovery_action_link'
      })
      return res.redirect(302, recoveryActionLink)
    }

    if (metadataSource === 'agreement_checkout') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_onboarding_pending_no_recovery_link',
        target: 'public_checkout_status'
      })
      return res.redirect(302, agreementStatusUrl('setup_pending'))
    }

    const pendingOnboardingUrl = buildPublicPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id,
      onboarding: 'pending'
    })
    console.log('subscription_checkout_success_onboarding_pending_fallback:', {
      client_id: client.id,
      target: 'pending_onboarding_pwreset'
    })
    console.log('subscription_checkout_success_redirect:', {
      branch: 'onboarding_pending_no_recovery_link',
      target: 'pending_onboarding_pwreset'
    })
    return res.redirect(302, pendingOnboardingUrl)
  } catch (e) {
    console.error('subscription_checkout_success_handoff_failed:', e?.message || e)
    if (parsedMetadataSource === 'agreement_checkout') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'agreement_checkout_handler_exception',
        target: 'public_checkout_status'
      })
      return res.redirect(302, makePublicCheckoutStatusUrl('setup_pending', fallbackClientId))
    }
    console.log('subscription_checkout_success_redirect:', {
      branch: 'handler_exception',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }
})

app.use('/admin', adminRouter)

/* ======================= END: Admin guard + Admin API ======================= */

app.use('/kb', require('./routes/kb'))
app.use('/', require('./routes/tavus'))
app.use('/', require('./routes/publicInterviewStatus'))
try {
  app.use('/membership-agreements', require('./routes/membershipAgreementsPublic'))
} catch (e) {
  console.error('[mount] Failed to load routes/membershipAgreementsPublic:', e?.message || e)
}

// ---------- JD upload route (authenticated + scoped) ----------
try {
  app.use('/roles-upload', requireAuth, withClientScope, require('./routes/rolesUpload'))
} catch (_) {}

// ---------- Protected mounts ----------
app.use(
  '/files',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/files')
)


app.use(
  '/reports',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/reports')
)

// ---------- Reports PDF (HTML→PDF) ----------
try {
  const reportsPdfRoutes = require('./routes/reportsPdf');
  app.use(
    '/reports',
    requireAuth,
    withClientScope,
    (req, _res, next) => {
      if (!req.client_memberships) {
        const ids = Array.isArray(req.memberships)
          ? req.memberships.map(m => m.client_id)
          : (req.clientIds || []);
        req.client_memberships = ids;
      }
      next();
    },
    reportsPdfRoutes
  );
  console.log('[mount] reportsPdfRoutes mounted at /reports');
} catch (e) {
  console.error('[mount] Failed to load routes/reportsPdf:', e?.message || e);
}

// ---------- Interview host shim (redirect to FE interview-access) ----------
app.get(['/interview-host', '/interview-host/:token'], (req, res) => {
  try {
    const token = req.params.token ? encodeURIComponent(req.params.token) : '';
    const targetPath = token ? `/interview-access/${token}` : '/interview-access';

    // Preserve any query string
    const qsIndex = req.url.indexOf('?');
    const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : '';

    const targetUrl = `${INTERVIEW_APP_BASE}${targetPath}${qs}`;
    return res.redirect(302, targetUrl);
  } catch (e) {
    return res.status(500).type('text/plain').send('redirect_failed');
  }
});
// Pretty link: https://interviews.alphasourceai.com/<token> -> /interview-host/<token>
app.get('/:token', (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  // Only act on the interviews subdomain; otherwise defer
  if (!isInterviewPrettyLinkHost(host)) return next();

  const token = req.params.token;
  // Conservative match: UUID v4 tokens only, prevents clashes with other paths
  const isUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  if (!isUuidV4) return next();

  // Preserve any query string when redirecting
  const qsIndex = req.url.indexOf('?');
  const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : '';
  return res.redirect(302, `/interview-host/${encodeURIComponent(token)}${qs}`);
});
// ---------- health ----------
// /health remains a lightweight liveness check.
// /healthz is a bounded readiness-ish probe that also tests Supabase Auth reachability.
app.get('/healthz', async (req, res) => {
  const request_id =
    req.request_id ||
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  const now = new Date().toISOString();
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_ANON_KEY || '');

  const supabase_auth = { ok: false, latency_ms: 0 };
  const tavus_webhook_auth = getTavusWebhookAuthReadiness();
  const support_voice = supportVoiceGateway.publicHealth();
  const startedAt = Date.now();

  if (!supabaseUrl || !anonKey || typeof fetch !== 'function' || typeof AbortController !== 'function') {
    supabase_auth.latency_ms = Date.now() - startedAt;
    if (!supabaseUrl) supabase_auth.error = 'Missing SUPABASE_URL';
    else if (!anonKey) supabase_auth.error = 'Missing SUPABASE_ANON_KEY';
    else if (typeof fetch !== 'function') supabase_auth.error = 'fetch unavailable';
    else supabase_auth.error = 'AbortController unavailable';

    return res.json({
      ok: false,
      degraded: true,
      request_id,
      now,
      interview_recovery_core: {
        enabled: isInterviewRecoveryCoreEnabled(),
        email_enabled: isInterviewRecoveryCoreEmailEnabled(),
      },
      supabase_auth,
      tavus_webhook_auth,
      support_voice,
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: anonKey },
      signal: controller.signal,
    });

    supabase_auth.ok = true;
    supabase_auth.status = response.status;
  } catch (err) {
    if (err?.name === 'AbortError') {
      supabase_auth.ok = false;
      supabase_auth.timeout = true;
    } else {
      supabase_auth.ok = false;
      supabase_auth.error = err?.message || String(err);
    }
  } finally {
    clearTimeout(timeoutId);
    supabase_auth.latency_ms = Date.now() - startedAt;
  }

  return res.json({
    ok: supabase_auth.ok === true && tavus_webhook_auth.ok === true && (support_voice.enabled !== true || support_voice.configured === true),
    degraded: supabase_auth.ok !== true || tavus_webhook_auth.ok !== true || (support_voice.enabled === true && support_voice.available !== true),
    request_id,
    now,
    interview_recovery_core: {
      enabled: isInterviewRecoveryCoreEnabled(),
      email_enabled: isInterviewRecoveryCoreEmailEnabled(),
    },
    supabase_auth,
    tavus_webhook_auth,
    support_voice,
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Sentry error handler (v8) — mount after routes
if (SENTRY_ENABLED) {
  if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app); // v8+
  } else if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') {
    app.use(Sentry.Handlers.errorHandler()); // v7
  }
}

// ---------- Error handler ----------
app.use(function (err, req, res, next) {
  const status = err.status || 500
  const msg = err.message || 'Server error'
  res.status(status).json({ error: msg })
})

// ---------- Start ----------
// Bind a port only when app.js is the entry point, so tests can require it safely.
const PORT = process.env.PORT || 3000

let server = null
function start() {
  if (server) return server
  server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
  // WebSocket gateway needs a live server to attach to.
  if (server && typeof server.on === 'function') {
    supportVoiceGateway.attach(server)
  }
  app.supportVoiceServer = server
  return server
}

if (require.main === module) {
  start()
}

app.supportVoiceGateway = supportVoiceGateway
app.start = start
module.exports = app

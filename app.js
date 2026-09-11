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
const multer = require('multer')
const path = require('path')
const { supabaseAdmin } = require('./src/lib/supabaseClient')
const { generateRubricAndKBForRole } = require('./generateRubric')
const dashboardRouter = require('./routes/dashboard')
const rolesRouter = require('./routes/roles')
const { createRoleJdReplacementRouter } = require('./routes/roleJdReplacement')
const automationRouter = require('./routes/automation')
const { requireAuth, withClientScope } = require('./src/middleware/auth')
const { createProfileRouter } = require('./routes/profile')
const { createSupportVoiceGateway } = require('./src/lib/supportVoiceGateway')
const { buildClientScopeContext, canViewLegalBillingForClient } = require('./src/lib/clientScope')
const { resolveBillingOwnerForScope } = require('./src/lib/clientBillingScope')
const { isInterviewRecoveryCoreEnabled, isInterviewRecoveryCoreEmailEnabled } = require('./src/lib/interviewAttemptService')
const { uniqueClientIds } = require('./src/services/clientScope/clientScope')
const { normalizeInterviewType } = require('./src/lib/interviewTypes')
const {
  finalizePrepaidRoleCredit,
  findUnusedFirstRolePrepayCredit,
} = require('./src/lib/rolePurchaseFinalizer')
const { processClientEntityImport } = require('./src/lib/clientEntityImportService')
const { archiveChildClientEntity } = require('./src/lib/clientEntityArchive')
const {
  frontendUrl: FRONTEND_URL,
  interviewAppBase: INTERVIEW_APP_BASE,
  corsDefaultOrigins,
  isInterviewPrettyLinkHost,
  buildClientDashboardReturnUrl,
  buildAcceptInviteUrl,
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
app.use('/internal', require('./src/routes/internal'))

app.use('/checkout', require('./src/routes/public/checkoutSuccess'))

app.use('/admin', require('./src/routes/admin'))

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
// Client-attributable errors keep their message; anything else answers generically,
// because err.message here carries database and vendor error text straight through
// to the caller. The detail goes to the log instead.
app.use(function (err, req, res, _next) {
  const status = Number(err?.status) || 500
  const isClientError = status >= 400 && status < 500
  if (!isClientError) {
    console.error('[error-handler] unhandled route error', {
      request_id: req?.request_id || null,
      method: req?.method || null,
      path: req?.originalUrl || null,
      message: err?.message || String(err),
      stack: err?.stack || null
    })
    if (SENTRY_ENABLED) { try { Sentry.captureException(err) } catch {} }
  }
  res.status(status).json({ error: isClientError ? (err?.message || 'Request error') : 'Server error' })
})

// ---------- Start ----------
// Bind a port only when app.js is the entry point, so tests can require it safely.
const PORT = process.env.PORT || 3000
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 10000)

let server = null
let shuttingDown = false

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

// Stop accepting new connections, let in-flight requests finish, then exit. Without
// this a deploy kills the process mid-request and loses whatever it was doing.
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} received; draining`)

  const finish = (code) => {
    try {
      supportVoiceGateway.finalizeAll()
    } catch (e) {
      console.error('[shutdown] voice gateway teardown failed', e?.message || e)
    }
    process.exit(code)
  }

  // A stuck connection must not hold the process past the grace window.
  const forced = setTimeout(() => {
    console.error('[shutdown] grace period elapsed; forcing exit')
    finish(exitCode || 1)
  }, SHUTDOWN_GRACE_MS)
  if (typeof forced.unref === 'function') forced.unref()

  if (!server) return finish(exitCode)
  server.close((err) => {
    clearTimeout(forced)
    if (err) {
      console.error('[shutdown] server close failed', err?.message || err)
      return finish(exitCode || 1)
    }
    finish(exitCode)
  })
}

// The two failure modes that previously terminated the process with nothing but a
// default stack trace. Both still terminate: continuing past them would leave the
// service running on state nobody can reason about.
function reportFatal(kind, error) {
  console.error(`[${kind}]`, {
    message: error?.message || String(error),
    stack: error?.stack || null
  })
  if (SENTRY_ENABLED) { try { Sentry.captureException(error) } catch {} }
}

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    reportFatal('unhandledRejection', reason)
    shutdown('unhandledRejection', 1)
  })
  process.on('uncaughtException', (error) => {
    reportFatal('uncaughtException', error)
    shutdown('uncaughtException', 1)
  })
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  start()
}

app.supportVoiceGateway = supportVoiceGateway
app.start = start
app.shutdown = shutdown
module.exports = app

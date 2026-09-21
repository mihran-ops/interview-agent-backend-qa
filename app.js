// app.js (drop-in)
require('dotenv').config()

// Loaded explicitly so serverless bundlers include the native canvas pdf-parse needs.
try { require('@napi-rs/canvas') } catch (_) {}

// --- Sentry MUST be initialized before requiring Express to instrument it ---
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');
const {
  getTavusWebhookAuthReadiness,
  redactTavusWebhookAuth,
} = require('./src/services/tavusWebhookAuth');
const { redactOtpLaunchTelemetry } = require('./src/services/otpLaunchTelemetry');
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
const path = require('path')
const { supabaseAdmin } = require('./src/clients/supabase')
const dashboardRouter = require('./src/routes/client/dashboardRouter')
const rolesRouter = require('./src/routes/client/roles')
const automationRouter = require('./src/routes/automation/index')
const { requireAuth, withClientScope } = require('./src/middleware/auth')
const { createSupportVoiceGateway } = require('./src/services/supportVoiceGateway')
const { isInterviewRecoveryCoreEnabled, isInterviewRecoveryCoreEmailEnabled } = require('./src/services/interviewAttemptService')
const {
  frontendUrl: FRONTEND_URL,
  interviewAppBase: INTERVIEW_APP_BASE,
  corsDefaultOrigins,
  isInterviewPrettyLinkHost,
} = require('./src/config/urlConfig')
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
app.use('/api/support/phone-handoff', require('./src/services/supportHandoff').createPhoneHandoffRouter())

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

app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require('./src/routes/webhooks/stripe'))
app.use('/webhook/telnyx/sms', express.raw({ type: 'application/json', limit: '256kb' }), require('./src/routes/webhooks/telnyx'))
app.use('/webhook/sendgrid', express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => {
    req.raw_body = Buffer.from(buffer);
  }
}), require('./src/routes/webhooks/sendgrid'))
app.use('/webhook', require('./src/routes/webhooks/tavus'))

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
app.use('/api/candidate/submit', require('./src/routes/public/candidateSubmit'))
app.use('/api/candidate/verify-otp', require('./src/routes/public/verifyOtp'))
app.use('/create-tavus-interview', require('./src/routes/public/createTavusInterview'))
app.use('/api/accommodations', require('./src/routes/public/accommodationRequests'))
app.use('/api/text-interview', require('./src/routes/public/textInterview'))

// ---------- Simple test endpoint ----------
app.use('/', require('./src/routes/client/index'))

const clientMembersScopedRouter = require('./src/routes/client/members')
app.use('/api/client-members', clientMembersScopedRouter)
app.use('/client-members', clientMembersScopedRouter)

app.use('/dashboard', dashboardRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/roles', rolesRouter)
app.use('/api/roles', rolesRouter)
app.use('/automation', automationRouter)
app.use('/api/automation', automationRouter)
app.use('/feedback', require('./src/routes/client/feedback'))
app.use('/api/feedback', require('./src/routes/client/feedback'))
app.use('/api/alphascreen', require('./src/routes/public/alphascreen/index'))
app.use('/api/public-analytics', require('./src/routes/public/analytics'))
app.use('/api/public-leads', require('./src/routes/public/leads'))

// ---------- Dashboard: scoped rows ----------
// Registered after the shared router mounts above, which is where these paths
// resolved before: routes/dashboard.js answers GET /dashboard/interviews too.
app.use('/', require('./src/routes/client/dashboard'))
app.use('/', require('./src/routes/client/invites'))
/* ========================= Admin guard + Admin API (with JD→Rubric→KB) ========================= */

// Admin-only guard (after requireAuth)
app.use('/internal', require('./src/routes/internal/index'))

app.use('/checkout', require('./src/routes/public/checkoutSuccess'))

app.use('/admin', require('./src/routes/admin/index'))

/* ======================= END: Admin guard + Admin API ======================= */

app.use('/kb', require('./src/routes/client/kb'))
app.use('/tavus', require('./src/routes/public/tavus'))
app.use('/public', require('./src/routes/public/interviewStatus'))
try {
  app.use('/membership-agreements', require('./src/routes/public/membershipAgreements/index'))
} catch (e) {
  console.error('[mount] Failed to load src/routes/public/membershipAgreements:', e?.message || e)
}

// ---------- JD upload route (authenticated + scoped) ----------
try {
  app.use('/roles-upload', requireAuth, withClientScope, require('./src/routes/client/rolesUpload'))
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
  require('./src/routes/client/files')
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
  require('./src/routes/client/reports')
)

// ---------- Reports PDF (HTML→PDF) ----------
try {
  const reportsPdfRoutes = require('./src/routes/client/reportsPdf');
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

# Refactor Survey — structural analysis for a human decision

**Repository:** `interview-agent-backend`
**Branch / commit surveyed:** `qa-backend` @ `8cf8f9b`
**Date:** 2026-09-06
**Status:** Read-only analysis. Nothing here has been applied. Every item is a proposal for a person to accept, modify or reject.

Line numbers are from the commit above and will drift as soon as anything is edited.

---

# PART 1 — app.js anatomy

## 1.1 Region map

`app.js` is 6,846 lines. It divides into fourteen contiguous regions. Two of them — the admin router body and a single redirect handler — account for 4,000 lines between them.

| # | Region | Lines | Size | Contents |
|---|---|---|---:|---|
| 1 | Sentry preamble | 1–60 | 60 | `require('dotenv')`, Sentry + profiling imports, `SENTRY_ENABLED` (11), `Sentry.init` (18), `tavusWebhookAuth` import (7–10) |
| 2 | Imports and config | 61–147 | 87 | 40 requires, `ROLE_CHECKOUT_JD_BUCKET` (143), `roleCheckoutUpload` multer instance (144) |
| 3 | App creation and support voice | 148–184 | 37 | `express()` (148), `TRUST_PROXY_HOPS` (149), `createSupportVoiceGateway` (165), `/api/support/voice` mount (183) |
| 4 | CORS, raw-body webhooks, JSON parser | 185–230 | 46 | Origin allowlist (186–197), `cors()` (198), three raw/custom-body webhook mounts (219–227), `express.json` (229) |
| 5 | Security-header and context middleware | 231–291 | 61 | CSP (232), Permissions-Policy (250), cache-control (260), request_id (280) |
| 6 | Public candidate mounts | 292–301 | 10 | Five routers: candidate submit, verify-otp, create-tavus-interview, accommodations, text-interview |
| 7 | Auth and tenant routes + helpers | 302–868 | 567 | `/auth/ping` (303), `/auth/me` (462), profile mount (499), client entity CRUD (502–815), billing summary (816); helpers at 307–411 |
| 8 | Client billing and role checkout | 869–1454 | 586 | Helpers 869–902, portal session (903), additional-interviews checkout (939), role checkout (1151) |
| 9 | Router mounts | 1455–1473 | 19 | Nine routers, most mounted twice (bare + `/api`) |
| 10 | Dashboard and invites | 1474–1685 | 212 | `buildDashboardRows` (1475), dashboard routes (1627, 1632), invites (1637, 1657) |
| 11 | Admin guard, helpers, adminRouter | 1686–2499 | 814 | `requireAdmin` (1686), `adminRouter` (1709), three sub-mounts (1713–1715), then ~35 helpers including `processContractRenewals` (1888) |
| 12 | adminRouter routes | 2500–6014 | 3,515 | 55 endpoints, with helpers interleaved (`loadAdminAutomationRule` 2789, `updateAdminAutomationRule` 2801) |
| 13 | Internal cron, checkout success | 6016–6627 | 612 | Three `/internal/*` routes (6016, 6033, 6064); `/checkout/subscription-success` (6089–6626) |
| 14 | Late mounts, health, error handling, listen | 6628–6846 | 219 | `/admin` mount (6628), seven more router mounts, health (6734, 6812), 404 (6815), error handler (6827), `listen` (6835), `module.exports` (6846) |

Two regions dominate:

- **Region 12 (3,515 lines)** is a single `express.Router()` declared at line 1709 and mounted at line 6628 — 4,900 lines from its declaration.
- **`GET /checkout/subscription-success` occupies lines 6089–6626 — 538 lines for one redirect handler.** It is larger than 30 of the 33 files in `routes/`.

## 1.2 Module-level state and helpers that routes depend on

These are the extraction blockers. Any route moved out of `app.js` must import these or receive them by injection.

**Shared singletons and config**

| Symbol | Line | Used by |
|---|---:|---|
| `supabaseAdmin` | 67 | Nearly every route. The dominant dependency |
| `app` | 148 | All route registrations |
| `supportVoiceGateway` | 165 | Mount at 183, `/healthz` at 6734, attached to `server` at 6843 |
| `ALLOWLIST` / `DEFAULT_ORIGINS` / `envOrigins` | 186–197 | CORS config (198) and CSP fallback (235) |
| `ROLE_CHECKOUT_JD_BUCKET` | 143 | Role checkout (1151) |
| `roleCheckoutUpload` | 144 | Multer instance used as route middleware at 1151 |
| `CLIENT_DASHBOARD_TABS` | 869 | `sanitizeClientDashboardTab` (870), checkout-success redirects |
| `TENANT_ENTITY_MANAGER_ROLES` | 357 | `hasTenantEntityManagementAccess` (372) |
| `adminRouter` | 1709 | All 55 admin routes |
| `PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH` | 1716 | Playbook route (2561) |
| `PORT` / `server` | 6834–6835 | Listen; `server` is also passed to the voice gateway |

**Inline helper functions** — roughly 45 at module scope, grouped by natural destination:

- *Client scope / tenancy* (307–411): `uniqueClientIds`, `loadClientScopeContextForResponse`, `clientScopeMetadata`, `normalizeTenantRole`, `findEffectiveClientMembership`, `hasTenantEntityManagementAccess`, `formatTenantClientEntity`, `resolveTenantEntityParent`
- *Client dashboard / billing* (869–902): `sanitizeClientDashboardTab`, `getClientMembershipRole`, `hasClientWriteAccess`, `wantsEmbeddedCheckout`, `respondWithBillingScopeError`
- *Dashboard* (1475): `buildDashboardRows` — 152 lines, serves both `/dashboard/interviews` and `/dashboard/rows`
- *Admin auth* (1686): `requireAdmin` — referenced by all 55 admin routes
- *User provisioning* (1719, 1774): `ensureUserIdAndInvite`, `ensureUserIdAndRecoveryLink`
- *Contracts* (1880, 1888): `addMonthsToIso`, `processContractRenewals` — 284 lines, called from both `adminRouter.post('/contracts/process-renewals')` (3651) and `app.post('/internal/contracts/process-renewals')` (6016)
- *Admin plumbing* (2172–2489): `trimNullableString`, `buildAdminClientHierarchyMaps`, `withAdminClientHierarchyMetadata`, `loadTopLevelParentClient`, `isUnavailableRelationError`, `countClientDeleteBlockers`, `rejectChildClientForAdminBilling`, `sendAdminError`, `cleanAdminUserEmail`, `normalizeAdminJsonObject`
- *Automation presentation* (2348–2489, 2789–2801): `automationSchedulerSendEnabled`, `automationSchedulerSecretConfigured`, `asJsonObject`, `summarizeKeyValues`, `summarizeAutomationRecipients`, `summarizeAutomationCadence`, `sanitizeAutomationSchedulingUrl`, `automationRuleStatus`, `maskEmail`, `deriveAutomationApprovalStatus`, `collectUniqueIds`, `loadAutomationLookupMap`, `resolveAdminAutomationClientIds`, `countRowsByStatus`, `loadAdminAutomationRule`, `updateAdminAutomationRule`

**The inline `require('stripe')` calls** — lines 923, 1000, 1264, 1920, 3460, 3567, 3889, 4071, 6118. Each constructs `new Stripe(process.env.STRIPE_SECRET_KEY || '')` locally. `lib/stripeClient.js:9` already exports a configured singleton with `apiVersion` pinned, and nothing in `app.js` uses it. This is the cheapest cleanup in the file and a prerequisite for testing any billing route without stubbing the `stripe` module by path.

## 1.3 Middleware and mount order

```
157/159  Sentry request handler (version-branched)
183      app.use('/api/support/voice', supportVoiceGateway.router)   <-- BEFORE cors
198      app.use(cors({...}))
219      app.use('/webhook/stripe',      express.raw(...), webhookStripe)
220      app.use('/webhook/telnyx/sms',  express.raw(...), webhookTelnyxSms)
221      app.use('/webhook/sendgrid',    express.json({verify}), webhookSendgrid)
227      app.use('/webhook', webhook)
229      app.use(express.json({ limit: '10mb' }))
232      CSP + HSTS + nosniff + Referrer-Policy
250      Permissions-Policy
260      Cache-Control: private, no-store for 8 path prefixes
280      request_id + Sentry tags
296-300  public candidate routers
303+     app-level routes and router mounts
6628     app.use('/admin', adminRouter)
6632-34  /kb, / (tavus), / (publicInterviewStatus)
6636     /membership-agreements
6643     /roles-upload
6647     /files          (requireAuth, withClientScope, shim)
6662     /reports        (routes/reports)
6679     /reports        (routes/reportsPdf)  <-- second mount, inside try/catch
6700     GET /interview-host, /interview-host/:token
6716     GET /:token     <-- catch-all
6734     GET /healthz
6812     GET /health
6815     404 handler
6827     error handler
```

**Order-sensitive points, in descending risk:**

1. **Raw-body webhooks must stay before `express.json` (219–227 before 229).** Stripe signature verification at `routes/webhookStripe.js:314` calls `stripe.webhooks.constructEvent(req.body, …)` and needs the unparsed `Buffer`. Reordering these mounts, or moving the JSON parser earlier, makes every Stripe webhook fail signature verification with a 400 — and no existing test would catch it, because no test loads `app.js` and posts to that path. The same constraint applies to Telnyx (220) and to the SendGrid `verify` callback (221).

2. **`GET /:token` at 6716 is a single-segment catch-all** registered before `/healthz` (6734) and `/health` (6812) in source order. Express matches in registration order, so those two health endpoints are reachable only if `/:token` declines them or calls `next()`. **This must be confirmed behaviourally before any reordering** — it is exactly what the Step 1 smoke tests are for.

3. **`/reports` is mounted twice** (6662, 6679). The second is wrapped in `try { … } catch` that logs and continues, so a load failure in `routes/reportsPdf.js` silently removes those endpoints while the service reports healthy. Two routers on one prefix also makes handling depend on which router matches first.

4. **The support-voice gateway mounts at 183, before `cors()` at 198.** `test/support-voice-security-boundary.test.js` asserts this ordering by regex, which suggests it is deliberate — the gateway does its own origin checking in `src/lib/supportVoiceGateway.js`. Preserve it.

5. **The nine dual mounts (1455–1472)** expose each router at both a bare and an `/api` path. Extraction must preserve both.

6. **The error handler at 6827** is correctly registered after the 404 at 6815, but returns `err.message` to the client — see Part 3.

---

# PART 2 — the rest of the codebase

## 2.1 The layer problem

Six directories hold what is conceptually one service layer, split by history rather than by role.

| Directory | Files | Live | Dead | Overlaps |
|---|---:|---|---|---|
| `src/lib/` | ~80 | Nearly all | `platformHealth/index.js` (barrel; tests import the leaves directly) | The canonical layer. Everything else duplicates part of it |
| `src/middleware/` | 3 | `auth.js` | `requireAuth.js`, `withClientScope.js` (4-line re-export shims) | `middleware/auth.js` re-exports this |
| `lib/` | 4 | `tavusDocuments.js`; `stripeClient.js` (exported, unused by app.js) | `tavusClient.js`, `createTavusInterviewInternal.js` | `tavusClient.js` vs `src/lib/tavusHttpClient.js` |
| `utils/` | 7 | `jdParser.js`, `mailer.js`, `pdfRenderer.js`, `renderCandidateReport.js`, `renderMembershipAgreement.js` | `pg.js` (requires `pg`, absent from package.json), `sendEmailOtp.js` | `sendEmailOtp.js` vs `src/lib/otpDelivery.js` |
| `handlers/` | 6 | none reachable | `recordingReady.js` (497), `tavusWebhook.js`, `createPaymentIntent.js`, `generateReport.js`; `createTavusInterview.js` is imported only by a test | `tavusWebhook.js` vs `routes/webhook.js` |
| `config/` | 2 | `urlConfig.js` (270) | `storage.js` (9) | `storage.js` bucket constants vs per-route env reads |
| `jobs/` | 1 | none | `sendNightlyDigests.js` | Digest logic now lives in `routes/automation.js` |
| `middleware/` | 1 | 1-line re-export | — | Shim for `src/middleware/auth` |

**Proposed layout.** One rule: `src/` is the application; the repository root holds only entry points and configuration.

```
app.js                     entry point only: wiring, mount order, listen
validateEnv.js             startup validation

src/
  routes/                  all HTTP routers (from routes/ + extracted from app.js)
  services/                business logic (today's src/lib/*, minus the categories below)
  clients/                 one module per external dependency:
                             supabase.js   (from src/lib/supabaseClient.js)
                             stripe.js     (from lib/stripeClient.js)
                             tavus.js      (from src/lib/tavusHttpClient.js)
                             sendgrid.js   (from utils/mailer.js)
                             openai.js     (new; consolidates 5 inline constructions)
                             telnyx.js     (from src/lib/telnyxSmsProvider.js)
  middleware/              auth.js, clientScope.js, requestContext.js, errorHandler.js
  render/                  jdParser, pdfRenderer, renderCandidateReport, renderMembershipAgreement
  config/                  urlConfig.js, buckets.js
  health/                  platformHealth/*
```

Deleted outright: `lib/`, `utils/`, `handlers/`, `jobs/`, `middleware/`, root `config/`, and the four re-export shims. That removes roughly 1,200 lines of unreachable code and five indirection layers, and it settles the "which `auth.js` is this?" question that currently has three answers.

## 2.2 The large route files

| File | Lines | Endpoints | Helpers | Assessment |
|---|---:|---:|---:|---|
| `routes/automation.js` | 3,941 | 22 | ~90 | **Split.** Lines 158–1100 are helpers and normalisers before the first route. Three concerns: rule CRUD, the approval-token flow, and the digest scheduler. Natural split: `automation/rules.js`, `automation/approvals.js`, `automation/digests.js`, with normalisers moving to `src/services/automation/` |
| `routes/webhook.js` | 3,425 | **2** | 68 | **Split, but differently.** Only two endpoints; the bulk is a Tavus event-processing pipeline. Extract the pipeline to `src/services/tavusEvents/` and leave a ~100-line router. Easiest large win — the HTTP surface barely changes |
| `routes/alphaScreenPackages.js` | 1,812 | 10 | 43 | **Split.** Public purchase intent, retail SMS/email verification, and agreement checkout are three flows sharing a file |
| `routes/adminBilling.js` | 1,516 | 11 | 19 | **Borderline.** Coherent single concern; split only if invoice sync (around 432) moves to a service |
| `routes/membershipAgreementsPublic.js` | 1,398 | 5 | 32 | **Split.** 5 endpoints and 32 helpers means the helpers are the file. Move signing and token logic to a service |
| `routes/textInterview.js` | 1,111 | 3 | 10 | **Leave.** Genuinely one flow |
| `routes/dashboard.js` | 908 | — | — | **Leave** structurally; see Part 3 for its query problems |

The signal across all of these is the helper-to-endpoint ratio. `webhook.js` at 68 helpers for 2 endpoints, and `membershipAgreementsPublic.js` at 32 for 5, are service layers wearing a router's clothes.

## 2.3 Cross-cutting duplication

| Concern | Implementations | Where | Which should win |
|---|---:|---|---|
| **HTTP client** | 4 | `axios` (app.js:70, routes/kb.js); `node-fetch` (7 live files incl. `src/lib/interviewAnalysisV2.js`, `src/lib/interviewScoring.js`, `src/lib/platformHealth/*`); `undici` (`src/lib/tavusHttpClient.js:3`); native `fetch` (app.js:6772, health probes) | **The `src/lib/tavusHttpClient.js` approach.** It is the only one with per-operation timeouts, retry-safety classification and bounded attempts (63–74). Generalise into `src/clients/http.js`; retire `node-fetch` (a v2 CommonJS dependency) and `axios`. Node 20 has native fetch |
| **Stripe client** | 4 patterns, 14 sites | 9 inline in app.js; `lib/stripeClient.js:9`; `routes/webhookStripe.js:13`; `src/lib/subscriptionCheckout.js:209`; `src/lib/platformHealth/stripeHealth.js:20`; `scripts/backfillClientBillingFromStripe.js:7` | **`lib/stripeClient.js`** — the only one pinning `apiVersion`. The rest construct with a bare key, so an SDK upgrade silently changes API version at 13 of 14 sites |
| **Supabase client** | 2 legitimate + 5 script-local | `src/lib/supabaseClient.js:19-20` (admin + anon); `routes/roles.js:388` builds a per-request user-scoped client; 5 in `scripts/` | **`src/lib/supabaseClient.js`.** The `routes/roles.js:388` per-request client is a genuine third case (user-token RLS scoping) and should become an exported factory rather than an inline construction |
| **Email sending** | 3 + 5 direct | `utils/mailer.js` (branded, the real one); `utils/sendEmailOtp.js` (dead); `src/lib/otpDelivery.js:24` (injectable); plus direct `sgMail` use in `routes/webhookSendgrid.js`, `routes/feedback.js`, `routes/accommodationRequests.js`, `routes/interviewRecovery.js`, `routes/roles.js` | **`utils/mailer.js` → `src/clients/sendgrid.js`.** The five routes calling `sgMail` directly each re-read `SENDGRID_API_KEY` and `SENDGRID_FROM` with different defaults, which is why the sender address varies by route |
| **ID generation** | 1, consistent | `crypto.randomUUID()` at 15 sites | **No change.** `uuid` and `nanoid` are in `package.json` but unused in live code — remove both dependencies |
| **Env alias reads** | 4 alias pairs | `SUPABASE_JOB_DESCRIPTIONS_BUCKET`/`SUPABASE_JD_BUCKET` (4 sites); `SUPABASE_SERVICE_KEY`/`_ROLE_KEY`; `SUPABASE_ANON_KEY`/`SUPABASE_PUBLIC_ANON_KEY`; `TAVUS_API_BASE`/`TAVUS_API_BASE_URL` | **A single `src/config/env.js`** resolving aliases once at boot. Today each fallback chain is retyped per call site, which is why `SUPABASE_ACCOMMODATION_RESUMES_BUCKET` already has two different defaults |

---

# PART 3 — performance and gaps

Every item below is a specific location. Where the live database may differ from what the repository declares, that caveat is stated.

## 3.1 Query patterns

**N+1 and sequential-await loops** (confirmed by reading each loop body, not by pattern match):

| Location | Pattern | Impact |
|---|---|---|
| `app.js:2282-2283` | `countClientDeleteBlockers` runs **8 sequential count queries**, one per table, looping over a `checks` array | 8 round-trips before an admin can delete a client. Trivially parallelisable with `Promise.all` |
| `app.js:4085-4087` | `for (const candidateId of candidateStripeCustomerIds) { await stripe.customers.retrieve(candidateId) }` | Sequential vendor calls to find a valid customer, each a network round-trip |
| `app.js:1946-1982` | `processContractRenewals` loops all clients, one `update` per client | Unbounded in client count; runs on both an admin route (3651) and a cron route (6016) |
| `routes/adminBilling.js:438-442` | `for (const invoiceId of stripeInvoiceIds) { await stripe.invoices.retrieve(...); await supabaseAdmin...update(...) }` | Two sequential round-trips per invoice |
| `routes/adminBilling.js:1419-1420` | `for (const item of normalizedItems) { await stripe.invoiceItems.create(...) }` | Sequential vendor writes inside a request |
| `routes/automation.js:1990` | `await mailer.sendPendingApprovalDigestEmail(...)` inside a per-recipient loop | Digest send time scales linearly with recipients, inside one request |

**Unbounded selects.** Across `app.js`, `routes/` and `src/lib/` there are **416 `.select(` calls, 74 `.limit(` calls and 2 `.range(` calls.** Specific unbounded list endpoints:

- `app.js:3176-3179` — `adminRouter.get('/clients')` selects 24 columns from `clients` ordered by `created_at`, no limit, no pagination.
- `app.js:4562` — `adminRouter.get('/candidates')` orders by `created_at` with no limit.
- `routes/dashboard.js:467-490` — 14 columns from `reports` with `.in('candidate_id', candIds)` and no limit; `candIds` is itself unbounded.
- `routes/dashboard.js:833-834` — `.eq('client_id', clientId).order('created_at')` with no limit.

These are correctness-adjacent as well as slow: response size grows without bound as a tenant grows.

**Indexes implied by filters but not declared in the repository.** The repository declares 128 indexes across `schema.sql` and `supabase/migrations/`. On the core tables:

```
client_members (user_id)
interviews     (candidate_id, role_id) ; (client_id)
reports        (candidate_external_id) ; (candidate_id, role_id, created_at DESC) ; (role_id)
roles          (client_id) ; (kb_document_id)
```

**No index on `candidates` appears in `schema.sql` or any migration**, yet `candidates.client_id` is the dominant filter in the codebase — `routes/dashboard.js:703`, `routes/dashboard.js:833`, `app.js:1487`, `app.js:4563`, `app.js:4906`. The primary key presumably covers `.in('id', candIds)` at `routes/dashboard.js:702`, but the `client_id` filter and the `created_at` ordering have no declared support.

*Caveat, stated plainly:* `schema.sql` is a dump last modified 2026-02-13 and referenced by no migration or script. Indexes may exist in the live databases without appearing in the repository. **Verify against the actual database before acting.** The finding is that the repository cannot answer the question — which is itself the problem.

## 3.2 Blocking and heavy work on request paths

| Location | Issue |
|---|---|
| `utils/pdfRenderer.js:61` | `await puppeteer.launch(launchCommon)` — a **full Chromium process per PDF request**, reached from `routes/reportsPdf.js`. No pooling, no concurrency limit, no queue. Two simultaneous report downloads mean two Chromium processes on a Render starter instance |
| `utils/pdfRenderer.js:21,29,38,42` | Four `fs.existsSync` calls resolving the Chromium binary, executed per render rather than once at boot |
| `utils/renderCandidateReport.js:117-118`, `utils/renderMembershipAgreement.js:192-193` | `fs.existsSync` + `fs.readFileSync` + base64 encode of the logo **per render**, uncached |
| `app.js:2563` | `fs.existsSync(PUBLIC_PURCHASE_PLAYBOOK_PDF_PATH)` inside the playbook route — synchronous stat per request |
| `utils/mailer.js:69` | `fs.readFileSync(filePath)` for attachments, synchronous, inside the send path |
| `app.js:229` | `express.json({ limit: '10mb' })` — a 10 MB body buffered in memory per request; with no concurrency limit this sets the per-request memory ceiling |
| `src/lib/supportVoiceKnowledge.js:27-28` | `fs.readFileSync` of the knowledge file and its hash — confirm this is boot-time only and not per session |
| `handlers/recordingReady.js:31,36,78,186,193,482-488` | Eleven sync fs operations plus two `ffmpeg()` invocations (47, 67). **Currently unreachable**, but if re-wired this puts video transcoding on a request path |
| `utils/renderCandidateReport.js:6`, `utils/renderMembershipAgreement.js:8` | `fs.readFileSync` of the Handlebars template at module scope — acceptable; happens once at import |

## 3.3 Missing infrastructure

| Concern | Status | Evidence |
|---|---|---|
| **Global error handler** | Present but leaky | `app.js:6827-6832` returns `err.message` directly, with the status defaulting to 500. Any internal error text, including database errors, reaches the caller |
| **`unhandledRejection` / `uncaughtException`** | **Absent.** Zero occurrences repository-wide | An unhandled rejection terminates the Node 20 process with no structured log |
| **Graceful shutdown** | **Absent.** No `SIGTERM`, `SIGINT` or `server.close()` anywhere | On a Render deploy the process is killed mid-request; in-flight report generation and Stripe calls are lost |
| **Request-body validation** | Partial, hand-rolled | No schema library in `package.json` — no zod, joi, ajv or express-validator. `src/lib/strictRequestValidation.js` is a solid hand-written normaliser (UUID checks, control-character rejection, byte and code-point caps) but `app.js` imports only `normalizeUuid` from it |
| **Request ID / correlation** | Present, not propagated | `app.js:280-291` sets `req.request_id` and a Sentry tag, echoed in many responses, but **not attached to outbound vendor calls**. No request logger: `morgan` is a dependency and is never required in `app.js` |
| **Outbound timeouts** | Excellent in one place, absent elsewhere | `src/lib/tavusHttpClient.js:63-74` defines per-operation timeout classes, retry safety and max attempts — the model to copy. Everything else (`axios` in `routes/kb.js`, `node-fetch` in `src/lib/interviewAnalysisV2.js` and `src/lib/interviewScoring.js`, all 14 Stripe constructions, all SendGrid sends) has **no timeout**, so a hung vendor holds a request until the platform kills it |
| **Webhook idempotency** | Good for Tavus, present for Stripe, absent elsewhere | `routes/webhook.js:73-84` derives a vendor event ID with a SHA-256 dedupe-key fallback and passes it to an RPC. `routes/webhookStripe.js:329,354` records and queries `stripe_event_id`. No equivalent found in `routes/webhookSendgrid.js` or `routes/webhookTelnyxSms.js` |
| **Retry on webhooks** | Not in-process | Relies on vendor redelivery — defensible given the idempotency above |
| **Health-check depth** | Two endpoints, different depth | `/healthz` (6734) actively probes Supabase auth with an `AbortController` timeout (6772) and reports Tavus webhook auth and support-voice readiness. `/health` (6812) is shallow. Neither checks Stripe, SendGrid, Telnyx or OpenAI, despite `src/lib/platformHealth/` containing probes for all four |

## 3.4 Security-relevant observations (logged, not audited)

Noted in passing. Each deserves its own assessment rather than action based on this survey.

1. `app.js:6827-6832` — the error handler returns raw `err.message` to clients.
2. `app.js:229` — a 10 MB JSON limit on every non-webhook route, with no request concurrency limit, is a cheap memory-pressure vector.
3. `app.js:149` — `TRUST_PROXY_HOPS` defaults to `1`; if the real hop count differs, `req.ip` becomes attacker-influenced, which matters because rate limiting keys on IP (`routes/alphaScreenPackages.js`, `routes/candidateSubmit.js:56`).
4. `app.js:235` — the CSP fallback allows `https://*.wixsite.com` and `https://*.filesusr.com` as frame ancestors: any subdomain of two third-party hosts.
5. `routes/dashboard.js:467-490` and `app.js:3176` — unbounded selects on tenant data are a denial-of-service surface as well as a performance one.
6. The 538-line `/checkout/subscription-success` handler (6089–6626) builds redirects from request parameters; redirect-target construction in a handler that size warrants a dedicated read.
7. `middleware/auth.js`, `src/middleware/requireAuth.js` and `src/middleware/withClientScope.js` are re-export shims — three import paths to one implementation makes it hard to be certain which guard a given route actually applies.

---

# PART 4 — proposed target structure and order

## 4.1 Target layout

```
app.js                        ~200 lines: middleware order, mounts, error handling, export
server.js                     listen + graceful shutdown + voice-gateway attach
validateEnv.js                startup validation (drafted separately in review/proposed/)

src/
  routes/
    public/       candidateSubmit, verifyOtp, createTavusInterview, accommodations,
                  textInterview, publicInterviewStatus, publicAnalytics, publicLeads,
                  membershipAgreementsPublic, checkoutSuccess, alphascreen/
    webhooks/     stripe, sendgrid, telnyx, tavus
    client/       auth, clientsMy, entities, billing, roleCheckout, dashboard, invites,
                  members, roles, files, reports, feedback, kb
    admin/        metrics, analytics, purchases, leads, automation, clients, entities,
                  billing, audit, roles, candidates, members, reliability, smsMonitoring
    internal/     contracts, otpCleanup, recordingCleanup
  services/       today's src/lib/*, plus logic extracted from routes/webhook.js,
                  routes/automation.js, routes/membershipAgreementsPublic.js
  clients/        supabase, stripe, tavus, sendgrid, openai, telnyx, http
  middleware/     auth, clientScope, requestContext, securityHeaders, errorHandler
  render/         jdParser, pdfRenderer, candidateReport, membershipAgreement
  config/         env (alias resolution), urlConfig, buckets
  health/         platform probes
test/
```

Mapping the 79 current app.js endpoints: the 24 app-level routes become `routes/client/` (20), `routes/internal/` (3) and `routes/public/checkoutSuccess.js` (1); the 55 admin routes split across the 14 files in `routes/admin/`, following groupings already visible in the source order.

## 4.2 Migration sequence

Each step is independently deployable and independently revertable. No step depends on a later one.

| # | Step | Guarding test | Effort | What could break |
|---|---|---|---|---|
| **1** | **Make app.js importable.** Guard `app.listen` (6835) with `if (require.main === module)`, move it and `supportVoiceGateway.attach(server)` into `server.js`, keep `module.exports = app`. Add supertest plus the Finding 002 smoke tests: `/healthz`, admin route rejects unauthenticated, Stripe webhook rejects a bad signature, `/internal/otp/cleanup` rejects a missing secret | The new smoke suite — this step creates the safety net for every later step | **S** | The Render start command must point at `server.js`. `test/role-checkout-session-route.test.js` monkey-patches `express.application.listen` (line 337); it can drop that workaround but must keep passing meanwhile |
| **2** | **Pin the route inventory.** A test asserting the full list of 79 method+path pairs, generated from the router stack rather than hand-written | Itself; it is the regression net for steps 5–8 | **S** | Nothing. Pure addition |
| **3** | **Consolidate the Stripe client.** Replace the 9 inline `require` sites in app.js with the `lib/stripeClient.js` singleton | Step 1 smoke tests plus a new billing-route test | **S** | `apiVersion` becomes pinned where it previously floated — check the current Stripe dashboard default before deploying |
| **4** | **Add operational infrastructure.** `unhandledRejection` and `uncaughtException` handlers, SIGTERM/SIGINT graceful shutdown in `server.js`, stop returning `err.message` from the handler at 6827 | A test asserting a generic body for a thrown error | **S** | Clients currently parsing `detail` out of 500 responses |
| **5** | **Extract the internal cron routes** (6016–6088, 73 lines) into `src/routes/internal/`; `processContractRenewals` moves to a service with them | Step 1 secret-rejection tests, extended to all three endpoints | **S** | `processContractRenewals` is shared with the admin route at 3651 — both callers must move together |
| **6** | **Extract the checkout-success route** (6089–6626, 538 lines) into `src/routes/public/`. One route, one file, an immediate 8% reduction in app.js | New tests for its redirect branches — currently untested | **M** | Redirect behaviour is intricate; the step most likely to need behavioural tests written first |
| **7** | **Extract the admin router** in slices, one group per deploy: audit, then analytics/purchases, automation, clients/entities, roles, candidates, members, billing. `requireAdmin` and the shared admin helpers move to `src/middleware/` and `src/services/admin/` on the first slice | Step 2 inventory test, plus per-slice route tests | **L** | The largest step. Helpers at 2172–2489 are shared across slices and must move first, in their own deploy |
| **8** | **Extract the client-scope routes** (302–1454) into `src/routes/client/`, with tenancy helpers (307–411, 869–902) moving to `src/services/clientScope/` | Step 2 inventory test, plus new per-route tests | **L** | `buildDashboardRows` (1475) is shared by two routes; `roleCheckoutUpload` (144) is a module-level multer instance that must travel with the role-checkout route |
| **9** | **Split the large route files.** `routes/webhook.js` first (2 endpoints, 68 helpers — the best ratio), then automation, alphaScreenPackages, membershipAgreementsPublic | Existing tests cover webhook.js; the other three need tests written first | **L** | webhook.js has real coverage and is the safe one. The other three have none — write tests before splitting, not after |
| **10** | **Collapse the layer directories.** Delete `handlers/`, `jobs/`, `middleware/`, `lib/tavusClient.js`, `lib/createTavusInterviewInternal.js`, `utils/pg.js`, `utils/sendEmailOtp.js`, `config/storage.js` and the shims; move survivors into `src/` | Full suite; these files are unreachable, so the risk is mis-identification rather than behaviour | **M** | Confirm each is genuinely unreferenced at the moment of deletion — `handlers/createTavusInterview.js` is imported by a test even though no production code uses it |
| **11** | **Unify the HTTP clients.** Generalise the tavusHttpClient timeout and retry model into `src/clients/http.js`; migrate the axios and node-fetch call sites; add timeouts to Stripe and SendGrid | Per-client tests with a stubbed transport | **M** | Timeouts where there were none will surface latent slow vendor calls as new errors — deploy to QA and watch before promoting |
| **12** | **Address the query patterns** from Part 3: parallelise `countClientDeleteBlockers`, paginate the unbounded admin lists, confirm and add the candidates indexes | Tests asserting pagination parameters are honoured | **M** | Pagination changes response shape — coordinate with the frontend |

**Sequencing note.** Steps 1–4 are small, low-risk and independently valuable; they land quickly and make everything after them testable. Steps 5–6 prove extraction works on a small target before step 7 commits to the large one. Steps 9–12 are independent of 5–8 and can run in parallel if more than one person is working.

**The one hard prerequisite:** step 1 comes first. Every later step is guarded by tests that cannot exist until app.js can be imported without binding a port.

---

*Static analysis only. No code was executed, no tests were run, and no files outside `review/proposed/` were created or modified.*

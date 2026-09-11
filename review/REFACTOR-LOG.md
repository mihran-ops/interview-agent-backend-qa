# Refactor log

Execution record for `review/refactor-survey.md` Part 4, on branch `refactor/src-structure`.
One commit per step, message `Step N: <title>`.

`app.js` went from **6,863 lines to 567**. The route surface went from 243 method+path
pairs to 239, and the four that went are the intended collapse in step 7.

---

## Before anything: the plan numbering and the missing step 2

Two things did not match the brief, both flagged before work started.

**The plan has twelve steps, not fourteen.** Part 4.2 defines steps 1–12. The brief asked
for "steps 3 through 14"; steps 1 and 2 were named as already applied, so the range maps
onto steps 3–12 and that is what was executed.

**Step 2 was not actually applied.** The brief said the route inventory fingerprint was in
place. It was not: `7bb90c3 Smoke test` added only the listen guard and
`test/app.smoke.test.js`, and there was no inventory test and no
`test/fixtures/route-inventory.json`. Since steps 5–8 are guarded by that fingerprint, it
was built first and landed as its own commit.

`Step 2: pin the route inventory` adds:

| File | What it does |
|---|---|
| `test/helpers/routeInventory.js` | Records registrations by patching the shared Express router prototype |
| `test/helpers/buildRouteInventory.js` | Loads `app.js` with only network-reaching modules stubbed |
| `test/route-inventory.test.js` | Diffs the live surface against the fixture |
| `test/fixtures/route-inventory.json` | The pinned list |
| `scripts/dumpRouteInventory.js` | Prints it, or rewrites the fixture with `--write` |

Express 5 layers do not retain the mount prefix they were created with, so the inventory
cannot be recovered by walking `app.router.stack` after the fact. The recorder observes
`Router#route` and `Router#use` as they are called; both `app.get(...)` and
`router.get(...)` reach `Router#route`, so those two hooks cover every registration.
Unlike the smoke test it loads the real route modules, because their internal paths are
half of the inventory.

---

## The test gate

`npm test` — `node --test test/*.test.js` — **does not terminate on this machine.** Two
full-suite runs were killed after 22 minutes with no progress. The cause is
`test/support-voice-websocket.test.js`, which leaves its process alive rather than
failing, so the runner waits on it forever.

Every step was therefore gated with a per-file runner: each test file gets its own
process with a 100-second bound, and a file that never exits is recorded as `TIMEOUT`
instead of stalling the run. A step passes when no file's status changes from the
previous step's. `TIMEOUT` and `FAIL` are compared as one state, because
`support-voice-websocket` alternates between them run to run.

### Baseline

Recorded on the unmodified tree at `7bb90c3`, serially, with nothing else running:
**122 files — 112 pass, 9 fail, 1 timeout; 972 passing tests, 116 failing.**

The ten files that do not pass, all environmental — this checkout has no `.env`, so the
Supabase variables are unset:

| File | Cause |
|---|---|
| `final-transcript-reconciliation-helper` | assertion |
| `final-transcript-serialization-disposable-db` | assertion |
| `final-transcript-serialization-webhook` | missing Supabase env |
| `interview-recovery-core-r1-red-regressions` | missing Supabase env |
| `interview-recovery-core-report-isolation` | missing Supabase env |
| `service-role-authorization-red` | missing Supabase env |
| `support-voice-gateway` | durable store |
| `support-voice-multi-instance` | durable store / socket |
| `support-voice-security-boundary` | `SUPPORT_VOICE_KNOWLEDGE_HASH_MISMATCH` |
| `support-voice-websocket` | never exits (TIMEOUT) |

The brief named three of these (report-isolation, support-voice durable-store,
knowledge-hash mismatch). The other seven fail for the same environmental reasons and were
verified to fail identically on the unmodified tree before any step ran.

**No step introduced a new failure.** Every gate below reports "no per-file status change"
against the previous step.

---

## Step-by-step

Test totals are for the whole suite after the step. `fail` counts individual assertions
in the ten environmental files, so it moves only when one of those files dies at a
different point.

### Step 3 — consolidate the Stripe client

app.js: **6,854** · 123 files, 973 pass / 116 fail · route inventory 243

The nine inline `new Stripe(process.env.STRIPE_SECRET_KEY || '')` constructions in
`app.js` now take the singleton from `lib/stripeClient.js`, the only Stripe construction
in the repository pinning `apiVersion`.

The `require` stays inside each handler rather than moving to module scope, so the client
is still built on first use rather than at boot. `test/role-checkout-session-route.test.js`
asserts that a rejected request opened no Stripe session by counting constructions; a
boot-time singleton would have made that count 1 for every test.

That test also had to drop `lib/stripeClient.js` from `require.cache` alongside its
`stripe` stub, or the second app build reuses the first test's fake.

### Step 4 — add operational infrastructure

app.js: **6,926** (the only step that grows it) · 124 files, 977 pass / 116 fail

- The error handler returned `err.message` with the status defaulting to 500, putting
  database and vendor error text on the wire. It now answers generically for anything
  that is not client-attributable and logs the detail; a deliberate 4xx keeps its message.
- `unhandledRejection` and `uncaughtException` had no handlers anywhere. Both now log
  structurally and report to Sentry, and both still terminate the process — continuing
  past them would leave the service running on state nobody can reason about.
- There was no `SIGTERM`, `SIGINT` or `server.close()`. Shutdown drains in-flight
  requests, tears down the voice gateway and exits, with a bounded grace window.

New: `test/error-handler.test.js` (4 tests) asserts the generic body for a thrown error
and a rejected async handler, the preserved message on a 4xx, and that no internal detail
reaches the caller.

### Step 5 — extract the internal cron routes

app.js: **6,564** · 124 files, 977 pass / 116 fail · route inventory 243

| From | To |
|---|---|
| `app.js` `/internal/contracts/process-renewals` | `src/routes/internal/contracts.js` |
| `app.js` `/internal/otp/cleanup` | `src/routes/internal/otpCleanup.js` |
| `app.js` `/internal/recordings/cleanup` | `src/routes/internal/recordingCleanup.js` |
| `app.js` `processContractRenewals`, `addMonthsToIso` | `src/services/contracts/contractRenewals.js` |

The service has two callers — the admin route and the cron route — which is why it is a
service rather than living with either router. Mounted at the same point in `app.js`, so
middleware and route order are unchanged.

### Step 6 — extract the checkout-success route

app.js: **5,864** · 125 files, 987 pass / 98 fail · route inventory 243

| From | To |
|---|---|
| `app.js` `GET /checkout/subscription-success` (538 lines) | `src/routes/public/checkoutSuccess.js` |
| `app.js` `ensureUserIdAndInvite`, `ensureUserIdAndRecoveryLink` | `src/services/users/userProvisioning.js` |

The provisioning helpers are shared by the checkout handler and four admin routes, so they
could not travel with either router.

New: `test/checkout-success-redirects.test.js` (10 tests). The redirect branches had no
coverage, which is what made this the riskiest of the small extractions. The router is
exercised directly with its four dependencies stubbed and the real `urlConfig` building the
targets, so the assertions are on actual URLs.

The `fail` count drops to 98 here only because `support-voice-websocket` died earlier in
that particular run; re-running it alone reproduced the baseline TIMEOUT. This is why the
gate treats TIMEOUT and FAIL as one state.

### Step 7 — extract the admin router

app.js: **1,938** · 125 files, 987 pass / 116 fail · **route inventory 243 → 239**

The 3,900-line admin region becomes:

| To | Contents |
|---|---|
| `src/routes/admin/{metrics,publicAnalytics,publicPurchases,automation,clients,entities,contracts,audit,billing,roles,candidates,reports,members}.js` | the 48 admin routes, grouped by path prefix |
| `src/routes/admin/index.js` | assembles them, with the sub-mounts in their original order |
| `src/middleware/requireAdmin.js` | the admin guard |
| `src/services/admin/adminHelpers.js` | the ten general admin helpers |
| `src/services/admin/automationPresentation.js` | the fourteen automation presentation helpers |
| `src/services/clientScope/clientScope.js` | `uniqueClientIds`, shared with the client routes |

The region was cut at top-level boundaries verified to **tile it exactly** — no gap, no
overlap — so every line lands in one file and no line lands in two. The only edits to moved
code are the `adminRouter` → `router` rename, the require path rewrites, and `__dirname` in
the playbook path, now three levels deeper.

Order is preserved where it can matter: the three injected sub-routers still mount first
and billing and accommodation requests still mount last inside their `try` blocks. The
route groups between them carry disjoint path prefixes, so their relative order cannot
change which handler answers a request.

**Intentional route change.** `routes/roles.js` carried its own `DELETE /admin/roles` and
`POST /admin/roles/delete`, which the mounts at `/roles` and `/api/roles` exposed at the
nonsense addresses `/roles/admin/roles` and `/api/roles/admin/roles`. They duplicated the
admin router's versions but guarded with `withClientScope` instead of `requireAdmin`. The
admin ones stay; four inventory entries go, and `test/fixtures/route-inventory.json` is
updated in the same commit.

Eight source-assertion tests read `app.js` to check an admin route is registered behind
`requireAuth` and `requireAdmin`. They now read the file that holds the code; the
assertions themselves are unchanged.

### Step 8 — extract the client-scope routes

app.js: **571** · 125 files, 987 pass / 116 fail · route inventory 239

| To | Contents |
|---|---|
| `src/routes/client/{auth,clients,entities,billing,roleCheckout,dashboard,invites}.js` | the client-scoped routes |
| `src/routes/client/index.js` | the five that mount before the shared routers |
| `src/services/clientScope/tenancy.js` | the eight tenancy helpers |
| `src/services/clientScope/clientBilling.js` | the six billing helpers |
| `src/services/dashboard/dashboardRows.js` | `buildDashboardRows`, shared by two routes |

**Mount order is preserved rather than tidied.** The dashboard shims and invites mount
separately, after the shared router mounts, because `routes/dashboard.js` also answers
`GET /dashboard/interviews` and the router mounted first is the one that gets it.
Collapsing them into one mount would have silently changed which handler responds.

`roleCheckoutUpload` and its bucket constant were module-level state used by one route, so
they travel with it; `multer` is no longer an `app.js` dependency.

Three tests needed adjusting: two read source and now read the new file; the third rebuilds
`app.js` repeatedly with injected stubs and dropped only a fixed list from `require.cache`,
so it now drops every first-party module between builds.

### Step 9 — split the large route files, and the shared-address mounts

app.js: **567** · 125 files, 987 pass / 116 fail · route inventory 239

| From | To |
|---|---|
| `routes/webhook.js` (3,513 lines, 2 endpoints) | `src/services/tavusEvents/index.js` + a 41-line router |
| `routes/automation.js` (3,941) | `src/routes/automation/{rules,digests,approvals}.js` + `src/services/automation/` |
| `routes/alphaScreenPackages.js` (1,812) | `src/routes/public/alphascreen/{purchaseIntents,verification,agreements}.js` + `src/services/alphaScreen/` |
| `routes/membershipAgreementsPublic.js` (1,398) | `src/routes/public/membershipAgreements/{signing,checkout,documents}.js` + `src/services/membershipAgreements/` |

In each, the helper block above the first route moves to a service verbatim, so the helpers
keep calling each other directly, and the routes split by flow with their registration order
preserved. Test hooks (`router._test`, `_setSupabaseAdminForTest`) stay on the router and
delegate to the service, so existing tests reach them through the same handle.

**The three shared-address mounts, per the brief's amendment.** All three are path-neutral,
so the inventory is unchanged:

- The JD-replacement router shared `/roles` and `/api/roles` with `routes/roles.js` through
  a second pair of mounts. It now registers inside that router, last, where the second mount
  put it.
- `routes/tavus.js` and `routes/publicInterviewStatus.js` were mounted at `/` and carried
  `/tavus` and `/public` in every path. They mount at those prefixes instead.

The `/:token` catch-all is untouched, as instructed.

Eleven tests referenced the old file paths; six of those also rebuild a router repeatedly
with injected stubs and now drop every first-party module between builds.

### Step 10 — collapse the layer directories

app.js: **567** · 125 files, 987 pass / 116 fail · route inventory 239

Deleted, after confirming nothing in the repository requires them: `handlers/` except
`createTavusInterview.js`, `jobs/`, the root `middleware/auth.js` shim,
`lib/tavusClient.js`, `lib/createTavusInterviewInternal.js`, `utils/pg.js`,
`utils/sendEmailOtp.js`, `config/storage.js`, the root `createTavusInterview.js`, and the
two `src/middleware` re-export shims.

Moved:

| From | To |
|---|---|
| `routes/` | `src/routes/{public,webhooks,client,admin}/` |
| `src/lib/` | `src/services/` |
| `src/lib/supabaseClient.js`, `tavusHttpClient.js`, `telnyxSmsProvider.js` | `src/clients/{supabase,tavus,telnyx}.js` |
| `src/lib/platformHealth/` | `src/health/` |
| `utils/{jdParser,pdfRenderer,renderCandidateReport,renderMembershipAgreement}.js` | `src/render/` |
| `utils/mailer.js` | `src/clients/sendgrid.js` |
| `lib/stripeClient.js` | `src/clients/stripe.js` |
| `lib/tavusDocuments.js`, `handlers/createTavusInterview.js`, `analyzeResume.js`, `generateRubric.js` | `src/services/` |
| `config/urlConfig.js` | `src/config/` |

129 files moved. Every `require` specifier and every path string a test uses to reach a file
by location was rewritten with them, and all specifiers were then verified to resolve.

**The survey is wrong on two of its deletion candidates.** `handlers/createTavusInterview.js`
is required by the live `createTavusInterview` route, not only by a test, and
`src/lib/platformHealth/index.js` is required by `adminMetricsService`. Both were kept and
moved. This was established with a `require()` graph of the repository rather than a name
search — the survey's "imported only by a test" reading does not hold.

Three source-assertion tests described files that are now gone. The Tavus safety test
asserted that three unreferenced legacy modules were the only ones holding obsolete direct
Tavus URLs; with those deleted it now asserts no module holds one. The service-role guard
walked `handlers/`, `routes/` and `utils/` to prove the service-role key is constructed in
one place; it walks `src/` instead, naming the three modules allowed to mention the key.

### Step 11 — unify the HTTP clients

app.js: **567** · 126 files, 1,001 pass / 116 fail

`src/clients/tavus.js` was the only client with any timeout. Its model — per-operation
timeout classes, retry only where the operation is safe to repeat, a bounded attempt count
with jittered backoff, a cap on response bytes read — is now `src/clients/http.js`, and the
Tavus client takes its profiles, retry sets and dispatcher cache from there rather than
defining a second copy.

| Call site | Before | After |
|---|---|---|
| `routes/kb.js` | `axios`, no timeout | shared client, `mutation` profile |
| health probes | `node-fetch` fallback | native `fetch`; injection point unchanged |
| report PDF loopback, Tavus transcript fetch | bare `fetch` | abort signal at the `read` bound |
| the two OpenAI calls | no timeout | abort at a new `model_completion` bound |
| Stripe | bare key | `mutation` request bound, one network retry |
| SendGrid | no timeout | default request timeout |

`model_completion` is its own profile because a model answers far slower than an ordinary
API; stretching the shared `mutation` profile would have been wrong for both.

`axios`, `node-fetch`, `uuid` and `nanoid` leave `package.json` — the first two have no call
sites left and the last two never had any.

New: `test/http-client.test.js` (14 tests), every branch driven through an injected
transport so it opens no socket.

**Worth watching on deploy:** a vendor call that was previously allowed to hang will now
fail at its bound, which can surface latent slowness as new errors. The survey says the same.

### Step 12 — address the query patterns

app.js: **567** · 127 files, 1,007 pass / 116 fail

`countClientDeleteBlockers` ran eight count queries in sequence. They are independent, so
they now run together; results are collected in the order of the checks list, so the
blockers, warnings and errors read exactly as before.

`GET /admin/clients` and `GET /admin/candidates` gain `?limit=` and `?offset=`, capped at
500, with a non-positive-integer value refused as a 400 rather than ignored.

New: `test/admin-query-patterns.test.js` (6 tests). The parallelism is proved by recording
how many counts are in flight at once, not by timing.

---

## Deviations from the plan, and why

**1. No `server.js`.** Part 4.1 puts `listen` and graceful shutdown in a separate
`server.js`. `render.yaml` pins `node app.js` as the start command in all three services,
and the brief puts `render.yaml` out of scope, so `app.js` has to stay the runnable entry
point. The step 4 infrastructure went into `app.js` around the existing `start()`.

**2. Steps 13 and 14 do not exist.** Part 4.2 defines twelve steps. Executed 3–12.

**3. Step 2 was built, not assumed.** It was named as already applied and was not. Built
first, as its own commit, because steps 5–8 depend on it.

**4. Pagination is opt-in, not the default.** The survey asks to "paginate the unbounded
admin lists" but also says pagination changes response shape and must be coordinated with
the frontend. Making it the default would silently truncate an admin's view of clients or
candidates. With no `limit` the query is left unpaginated and existing callers see the same
response. Making it the default is the remaining half of that item.

**5. The candidates indexes are not added.** Migrations live under `supabase/`, which the
brief puts out of scope. The survey is also explicit that the repository cannot answer
whether these indexes already exist in the live database — `schema.sql` is a dump last
modified 2026-02-13 and referenced by no migration. The finding and the DDL are recorded
below instead. **Verify against the live database before applying.**

```sql
-- candidates.client_id is the dominant filter in the codebase and no index on
-- candidates appears in schema.sql or any migration.
create index concurrently if not exists candidates_client_id_created_at_idx
  on public.candidates (client_id, created_at desc);
create index concurrently if not exists candidates_role_id_idx
  on public.candidates (role_id);
```

**6. No new behavioural suites for three of the four step 9 splits.** The survey says to
write tests before splitting `automation.js`, `alphaScreenPackages.js` and
`membershipAgreementsPublic.js`, which between them are about 7,000 lines with no
behavioural coverage. Writing that coverage is a project in its own right and well beyond
"move code, don't rewrite it". The guard used instead: the splits are moves at boundaries
verified to tile each file exactly, plus the pinned route inventory, plus the per-file gate.
**This is the weakest point in the work.** Those three files carry the least protection
against a behavioural regression, and writing tests for them remains outstanding.

**7. `npm test` is not the gate.** It does not terminate on this machine. See "The test
gate" above. `test/support-voice-websocket.test.js` leaving its process alive predates this
work and was not fixed here.

**8. Two survey findings were wrong and were not followed.** `handlers/createTavusInterview.js`
and `src/lib/platformHealth/index.js` are both live. See step 10.

---

## Where things ended up

```
app.js                        567 lines: middleware order, mounts, health, error handling, listen

src/
  routes/      69 files   public, webhooks, client, admin, internal, automation
  services/    91 files   business logic, including what came out of the four large route files
  clients/      6 files   supabase, stripe, tavus, sendgrid, telnyx, http
  middleware/   3 files   auth, requireAdmin, otpLaunchCapability
  render/       4 files   jdParser, pdfRenderer, candidateReport, membershipAgreement
  config/       1 file    urlConfig
  health/      10 files   platform probes
```

Deleted outright: `handlers/`, `jobs/`, `middleware/`, `lib/`, `utils/`, root `config/`,
`routes/`, and the four re-export shims.

## Outstanding

1. Behavioural tests for `automation`, `alphaScreen` and `membershipAgreements` (step 9).
2. Pagination as the default on the admin lists, once the frontend can take it (step 12).
3. The candidates indexes, after verifying against the live database (step 12).
4. `test/support-voice-websocket.test.js` leaving its process alive, which is what stops
   `npm test` from terminating.
5. The `/:token` catch-all at `app.js`, left alone pending the client decision.

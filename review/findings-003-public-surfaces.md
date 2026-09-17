# Findings 003 — public and money-moving surfaces

**Scope:** the four surfaces that accept unauthenticated internet traffic or move money.
**Code audited:** `c:/reviews/client-refactor`, branch `refactor-backend` — the tree being
prepared for Vercel, which is where the `src/routes/...` paths in this document resolve.
Line numbers are from the state at audit time and have shifted where fixes have since been
applied; see the commit implementing S1-1, S1-2, S1-4, S1-5, S2-1, S4-2 and S4-4.
**Date:** 2026-09-16
**Status:** Read-only. No application code was changed.

Every claim below is marked with how it was established:

- **[read]** — read from the source; file:line given.
- **[probe]** — confirmed by running a targeted `node:test` against the real router with the
  Stripe SDK and Supabase stubbed. No database, no network.
- **[unconfirmed]** — could not be established from the repository. Stated as a question,
  not a finding of fact.

---

## Summary in plain language

The Stripe webhook is, structurally, the best-built surface here. The signature is checked
on the raw body before anything happens, replay protection uses the right pattern, and the
code does not trust the amounts and IDs in the event — it looks them up in the database and
refuses if they disagree. That is better than most integrations.

Three things let it down. It grants entitlement without checking that the money actually
settled; if processing fails halfway it tells Stripe "success" so Stripe never retries, and
nothing else ever picks the event back up; and the whole replay defence rests on a database
constraint that is not written down anywhere in the repository.

The agreement-signing links are well made — long random tokens, stored hashed, taken from
the POST body rather than the URL, with server-side expiry. The weak point is the rate
limit in front of them, which a caller can defeat by sending one HTTP header. That matters
less than it sounds because the tokens are too long to guess, but the limiter is currently
providing no protection at all and will provide even less on Vercel.

The `GET /:token` catch-all is clean. It reads nothing from the database, logs nothing, and
cannot be used to enumerate interviews.

The cron endpoints are sound in design but, as configured, **will not run on Vercel at all** —
the schedule in `vercel.json` issues GET requests and the routes only accept POST. One of
those jobs is the OTP cleanup, so credential material would be retained indefinitely.

---

## 1. Stripe webhook

`src/routes/webhooks/stripe.js`, mounted at `app.js:156`.

### What is done well

- **Signature verified on the raw body, before any side effect.** The raw parser is mounted
  at `app.js:156` and `express.json` not until `app.js:166`, so `req.body` is still a Buffer
  when `stripe.webhooks.constructEvent` runs at `src/routes/webhooks/stripe.js:314`.
  **[probe]** A request with a bad signature returns 400 and performs **zero** database
  writes.
- **Replay protection uses the correct pattern.** The handler inserts into `billing_events`
  keyed on `stripe_event_id` *first* (`stripe.js:326-332`) and treats a unique violation as
  "already seen", returning 200 (`stripe.js:334-336`). This is insert-first, not
  check-then-act, so two simultaneous deliveries of the same event race at the database and
  exactly one proceeds. There is no application-level window between the check and the
  insert. **[probe]** A duplicate event performs the insert attempt and nothing else.
- **Unknown event types are ignored safely.** They match no branch, fall through to
  `markProcessed(true)` and return 200 (`stripe.js:785-786`). No error, no side effect.
- **Event payload fields are not trusted for entitlement.** The `additional_interviews`
  branch looks the purchase up in the database and refuses if the event metadata disagrees:
  client mismatch (`stripe.js:455`), role mismatch (`stripe.js:458`), quantity mismatch
  (`stripe.js:462`). Already-paid purchases short-circuit (`stripe.js:467`), and the update
  is conditional on current status (`stripe.js:482`). The role-purchase branch claims the
  row optimistically with `.is('finalized_role_id', null)` (`stripe.js:545-557`), so a
  double delivery cannot finalise twice.

### S1-1 — Entitlement is granted without checking that payment settled — **High**

`stripe.js:411-500` (additional interviews) and `stripe.js:522-560` (role purchase) act on
`checkout.session.completed` without inspecting `payment_status`. The only `payment_status`
check in the file is at `stripe.js:650`, in the plan-settings branch. **[read]**

**[probe]** A `checkout.session.completed` event carrying `payment_status: "unpaid"` marks
the purchase `paid` and proceeds to grant interview credit.

For card payments the session completes only once the charge succeeds, so this is not
currently exploitable if cards are the only method enabled. For delayed-notification methods
(bank debits, some wallets) Stripe sends `checkout.session.completed` with `payment_status:
"unpaid"` and confirms later with `checkout.session.async_payment_succeeded`. Enabling such a
method in the Stripe dashboard — a settings change, not a code change — turns this into free
credit. **[unconfirmed]** Which payment methods are enabled cannot be seen from the
repository.

Note the inconsistency: the redirect handler `src/routes/public/checkoutSuccess.js:72,98`
*does* check both `payment_status` and `status === 'complete'`. The cosmetic path is stricter
than the authoritative one.

**Fix.** Gate both grant branches on
`['paid','no_payment_required'].includes(String(eventObject?.payment_status || '').toLowerCase())`,
and handle `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`
so delayed payments still provision and failures do not.

### S1-2 — A failed event is dropped permanently — **High**

The catch block marks the event `processed_ok: false` and returns **200**
(`stripe.js:788-791`). **[read]** Two consequences compound:

1. Stripe treats 200 as success and never retries.
2. The `billing_events` row already exists, so if the event were redelivered it would be
   rejected as a replay by `stripe.js:335`.

**[read]** Nothing in the repository ever reads `billing_events.processed_ok`. A grep for
`processed_ok` returns only this file and `contract_processing_runs`, a different table
surfaced in the admin audit view.

So a transient Supabase error during a paid checkout leaves the customer charged and
unprovisioned, with no retry, no alert and no queue to drain. The failure is recorded in a
column nobody reads.

**Fix.** Distinguish permanent from transient failures. Return 500 for transient ones so
Stripe's own retry schedule applies — and because the dedupe row already exists, either
delete it on failure or make the dedupe check treat `processed_ok = false` as "not yet
processed". Add an alert on rows where `processed_ok = false`.

### S1-3 — Replay protection depends on a constraint that is not in the repository — **High, unconfirmed**

The entire replay defence is the unique violation at `stripe.js:335`, which requires a unique
constraint or index on `billing_events.stripe_event_id`.

**[unconfirmed]** `billing_events` is not created in any of the 68 files in
`supabase/migrations/`, and does not appear in `schema.sql` or `schema_public.sql`. The only
definition in the repository is a test stub in
`test/fixtures/supabase-public-api-containment-bootstrap.sql:43`, which is
`(id bigserial primary key, value text)` — it does not even have a `stripe_event_id` column,
so it tells us nothing about production.

If the constraint is absent in the live database, every duplicate delivery inserts a new row,
`isUniqueViolation` never fires, and every event is processed as many times as Stripe delivers
it. Stripe retries on any non-2xx and can deliver more than once at least once by design.

**Fix.** Confirm against the live database:
`select indexdef from pg_indexes where tablename = 'billing_events';`
If no unique index on `stripe_event_id` exists, add one, and add the table to
`supabase/migrations/` so this is answerable from the repository in future.

### S1-4 — The webhook builds its own Stripe client, bypassing the configured one — **Low**

`stripe.js:3,13` does `new Stripe(process.env.STRIPE_SECRET_KEY || '')`, not
`require('../../clients/stripe')`. **[read]** The shared client pins `apiVersion` and sets a
request timeout; this one does neither, so an SDK upgrade silently changes the API version
here, and the `stripe.subscriptions.retrieve` call at `stripe.js:771` can hang without bound.

**Fix.** `const stripe = require('../../clients/stripe');` and delete the local construction.

### S1-5 — Signature failure returns Stripe's raw error text — **Low**

`stripe.js:319` returns `err?.message` to the caller. **[read]** The message comes from the
Stripe SDK and describes why verification failed. It is minor, but it is free information
about the verification path to an unauthenticated caller.

**Fix.** Return a fixed string; log the detail server-side with the request id.

---

## 2. Public agreement-token endpoints

`src/routes/public/membershipAgreements/`, helpers in `src/services/membershipAgreements/index.js`.

Three of the five routes are public: `POST /session` and `POST /sign`
(`signing.js:38,129`) and `POST /checkout-session` (`checkout.js:31`). The two
`/latest-signed*` routes (`documents.js:16,83`) require `requireAuth` and are not part of
this surface.

### What is done well

- **Token strength.** `crypto.randomBytes(32).toString('hex')` — 256 bits from a CSPRNG, 64
  hex characters (`src/routes/admin/billingRouter.js:930`,
  `src/routes/public/alphascreen/agreements.js:181`). Not guessable. **[read]**
- **Stored hashed, never in plaintext.** The row holds `signer_token_hash`
  (`billingRouter.js:931`), the lookup is by SHA-256 of the presented token
  (`index.js:89`, `index.js:581`). A database read does not yield usable tokens. **[read]**
- **Taken from the POST body, not the URL.** `readToken` reads `req.body.token`
  (`index.js:84-86`). The token therefore does not appear in query strings, access logs, or
  `Referer` headers on the API side. **[read]**
- **Expiry enforced server-side** on every use (`index.js:212`, `index.js:495`), not merely
  encoded in the link. **[read]**
- **Comparison does not need to be timing-safe.** The lookup is an indexed equality match on
  a SHA-256 hash of a 256-bit secret (`index.js:581`). There is no practical timing oracle
  against a hash, and no amount of timing information helps guess 256 bits. This is fine as
  written.

### S2-1 — The rate limit can be bypassed with one header — **High**

`index.js:40-42`:

```
function getRequestIp(req) {
  return String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
}
```

**[read]** This reads the raw `X-Forwarded-For` header and takes the first value. `req.ip` —
the value Express derives *after* applying the `trust proxy` setting configured at
`app.js:105` — is only the fallback, used when the header is absent.

A caller sends `X-Forwarded-For: <anything>` and gets a fresh bucket. Changing it per request
means the limit at `index.js:54` is never reached. This is worse than the
`TRUST_PROXY_HOPS` question: the hop count is irrelevant because the header is never passed
through that logic at all.

The tokens are too long to brute-force, so this is not an immediate breach. But the limiter
is the only control in front of `/sign` and `/checkout-session` and it currently provides
nothing — including against simple request flooding.

**Fix.** Use `req.ip` alone and let the configured `trust proxy` setting decide what is
trustworthy. Delete the direct header read.

### S2-2 — Rate-limit state is per-process and unbounded — **Medium**

`index.js:38` keeps buckets in a module-level `Map`. **[read]** It is never pruned — entries
are only replaced when the same key returns after its window. Two consequences:

- On Vercel the limiter is close to meaningless: serverless invocations do not share memory,
  so each cold start begins with an empty map.
- In a long-lived process, a caller varying the spoofable key (S2-1) grows the map without
  limit.

**Fix.** Move the counter to shared storage. The repository already has a rate-limit service
used by other public routes; reuse it rather than this local map.

### S2-3 — A valid token can sign and pay, and lives for 7 days — **Medium**

`SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000` (`billingRouter.js:21`,
`src/services/adminPublicPurchasesService.js:12`, `src/services/alphaScreen/index.js:41`).
**[read]** Within that window the bearer of the token can read the agreement
(`signing.js:38`), **execute it** (`signing.js:129`) and **start a Stripe checkout**
(`checkout.js:31`).

It is a bearer credential for a legal signature and a payment, delivered by email, valid for
a week. Anyone who receives a forwarded copy of that email, or who reads the recipient's
mailbox, can sign in the counterparty's name. The typed-name field captured at signing is
evidence, not authentication.

**Fix.** Shorten the TTL to hours rather than days; invalidate the token when the agreement
is signed rather than letting it stay live for the remainder of the week; and for the
signature step specifically, require a second factor the email alone does not carry, such as
a short code sent separately.

### S2-4 — Executed agreements are emailed as 7-day unauthenticated links — **Medium**

`index.js:35`: `AGREEMENT_SIGNED_EMAIL_LINK_TTL_SECONDS` defaults to `604800` — 7 days.
**[read]** That is the lifetime of a storage signed URL for the executed agreement PDF, a
document containing counterparty legal and contact details. Anyone with the URL can fetch it,
no account required.

**Fix.** Reduce the default sharply, or link to an authenticated page that issues a
short-lived URL on demand rather than mailing the URL itself.

### S2-5 — Invalid and expired tokens are distinguishable — **Low**

`index.js:193-199` returns 404 `token_invalid` for a token that matches no row;
`index.js:212-218` returns 410 `token_expired` for one that matched but is past its expiry.
**[read]** That is an oracle: it confirms a token once existed.

It is not practically exploitable. Reaching the oracle requires presenting a valid 256-bit
token, which cannot be guessed. Recorded for completeness rather than as a real risk; fix it
only if you want uniform responses on principle.

**Fix.** Return the same status and body for both, if desired.

---

## 3. `GET /:token` catch-all

`app.js:357-371`.

### Confirmed safe — nothing to fix

- **Host-gated.** Non-interview hosts call `next()` immediately (`app.js:360`). **[read]**
- **Format-gated.** Only an 8-4-4-4-12 hex string proceeds; anything else calls `next()`
  (`app.js:364-365`). **[read]**
- **It reads nothing from the database.** The handler's entire action is a 302 to
  `/interview-host/<token>` (`app.js:370`). **[read]** Because no lookup happens, the
  response is byte-identical for a token that exists and one that does not. **It cannot be
  used to enumerate interviews** — there is no oracle to observe.
- **It logs nothing.** No `console` call in the handler. **[read]** Tokens do not reach the
  application log from this path.
- **No injection or open-redirect surface.** The token is `encodeURIComponent`-escaped into a
  relative path (`app.js:370`); the redirect target is fixed and same-origin.
- **It does not swallow the health endpoints**, confirmed by `test/app.smoke.test.js`
  (`GET /healthz` and `GET /health` both return their own payloads).

### S3-1 — Comment overstates the check — **Low, cosmetic**

`app.js:363` says "UUID v4 tokens only", but the regex accepts any hex in the version and
variant positions. **[read]** No security impact — nothing is looked up — but the comment
should not be relied on as a validation guarantee elsewhere.

---

## 4. `/internal/*` cron endpoints and the automation digest runner

`src/routes/internal/{contracts,otpCleanup,recordingCleanup}.js`;
`requireAutomationRunnerAccess` in `src/services/automation/index.js:206`.

### What is done well

- **Secret is header-only.** `req.get('x-cron-secret')` (`contracts.js:14`,
  `otpCleanup.js:13`, `recordingCleanup.js:15`) and three header names in
  `automation/index.js:185-192`. **[read]** No endpoint accepts the secret in a query string,
  so it does not land in access logs or `Referer` headers.
- **Fails closed when unconfigured.** An unset secret rejects rather than matching the empty
  string (`contracts.js:15`, `otpCleanup.js:14`, `recordingCleanup.js:15`;
  `automation/index.js:197`). Covered by `test/app.smoke.test.js`.
- **Cleanup scope is bounded.** OTP deletion is limited to rows that are used or already
  expired (`otpCleanup.js:23`), with a server-generated timestamp — not a client-supplied
  one, so the filter cannot be widened by a caller.
- **Renewals are idempotent when run in sequence.** A contract qualifies only while
  `contract_end_at <= now` (`contractRenewals.js:80`), and renewal pushes that date twelve
  months forward (`contractRenewals.js:110-116`). A second run immediately afterwards
  matches nothing and does nothing.

### S4-1 — The Vercel cron schedule cannot trigger these endpoints — **High (operational)**

`vercel.json` schedules three paths. All three routes are registered as **POST only** —
confirmed against the pinned route inventory, which lists `POST /internal/contracts/process-renewals`,
`POST /internal/otp/cleanup` and `POST /internal/recordings/cleanup` and no GET equivalents.
**[read]**

Vercel's scheduler issues **GET** requests, and authenticates with its own
`Authorization: Bearer` header rather than `x-cron-secret`. **[unconfirmed]** — that is
Vercel's documented behaviour, not something this repository can prove; confirm against their
current docs before acting.

As written, the scheduled jobs will not run. Consequences, in order of seriousness:

- **OTP cleanup never runs** — used and expired one-time-password rows accumulate
  indefinitely. That is live credential material retained past its purpose.
- **Recording cleanup never runs** — retention of recordings with no substantive content is
  not enforced.
- **Contract renewals never run** — terms do not roll over, so billing state drifts from
  contractual state.

This is silent: the 404 goes to Vercel's log, not to anything anyone watches.

**Fix.** Accept GET on the three internal routes (or have Vercel call an endpoint that
fans out), and accept Vercel's `Authorization: Bearer <CRON_SECRET>` in addition to
`x-cron-secret`. Then verify in the Vercel dashboard that each job reports success.

### S4-2 — Two simultaneous renewal runs can advance a term twice — **Medium**

The eligibility gate reads `contract_end_at` (`contractRenewals.js:75-80`); the update that
follows filters on the row id alone — `.eq('id', client.id)` at `contractRenewals.js:110-116`
— with no condition on the value that was read. **[read]**

Two concurrent invocations both pass the gate with the same `oldContractEnd`, and both write.
The contract advances 24 months instead of 12. Sequential runs are safe (see above); it is
specifically concurrency. Anyone holding the cron secret can trigger this deliberately, and a
scheduler retry could do it accidentally.

**Fix.** Make the update conditional on the value read:
`.eq('id', client.id).eq('contract_end_at', oldContractEnd)`. The second writer then matches
zero rows and the run reports nothing renewed.

### S4-3 — The scheduler secret grants global admin — **Medium**

On a valid secret, `requireAutomationRunnerAccess` sets `req.isGlobalAdmin = true` and
`req.isAdmin = true` with a null user (`automation/index.js:209-212`). **[read]** And the
secret it accepts falls back to `CONTRACTS_CRON_SECRET` (`automation/index.js:176-182`) —
the same value that gates the three internal cron routes, which themselves fall back to it
(`otpCleanup.js:12`, `recordingCleanup.js:13`).

So one environment variable, held by whatever schedules these jobs, is simultaneously the
key to contract processing, OTP deletion, recording deletion and admin-level automation
identity. A single leak — a log line, a misconfigured third-party scheduler, a shared CI
variable — grants all of it.

**Fix.** Give each job its own secret and remove the shared fallback. Narrow the grant so the
runner can execute digests without being marked a global admin.

### S4-4 — Secret comparison is not timing-safe — **Low**

`providedSecret !== expectedSecret` (`contracts.js:15`, `otpCleanup.js:14`,
`recordingCleanup.js:15`) and `provided === expected` (`automation/index.js:197`). **[read]**

Being straight: a remote timing attack against a JavaScript string comparison, across a
network, through a serverless platform, is not a realistic way in. This is listed because the
fix is three lines and these secrets gate destructive work — not because it is likely to be
the way you are breached.

**Fix.** Compare with `crypto.timingSafeEqual` over equal-length buffers, after a length
check that itself returns a constant-time-safe result.

---

## Prioritised fix list

**High**

1. **S1-1** Gate Stripe entitlement on `payment_status`, and handle the
   `async_payment_succeeded` / `async_payment_failed` events. *(Confirmed by probe.)*
2. **S1-2** Stop returning 200 for failed webhook processing, so Stripe retries; add an
   alert on `billing_events.processed_ok = false`.
3. **S1-3** Verify the unique index on `billing_events.stripe_event_id` in the live database
   and add it to migrations. Until this is confirmed, treat replay protection as unproven.
4. **S2-1** Stop reading `X-Forwarded-For` directly in `getRequestIp`; use `req.ip`.
5. **S4-1** Make the `/internal/*` cron endpoints reachable by Vercel's scheduler, then
   confirm each job actually reports success.

**Medium**

6. **S2-3** Shorten the signing-link TTL and invalidate the token once the agreement is signed.
7. **S2-4** Shorten or replace the 7-day emailed link to the executed agreement PDF.
8. **S4-3** Separate the cron secrets; stop granting global admin to the digest runner.
9. **S4-2** Add `.eq('contract_end_at', oldContractEnd)` to the renewal update.
10. **S2-2** Move rate-limit counters out of process memory.

**Low**

11. **S1-4** Use the shared Stripe client in the webhook.
12. **S1-5** Stop returning the raw signature-verification message.
13. **S4-4** Use `crypto.timingSafeEqual` for the cron secrets.
14. **S2-5** Make invalid and expired token responses identical, if uniformity is wanted.
15. **S3-1** Correct the "UUID v4" comment.

---

## Confirmed safe — what not to worry about

These were specifically checked and are correct as built.

- **Stripe signature verification.** Done on the unparsed body, before any database write.
  The raw-body mount precedes `express.json`. A forged request performs no side effect.
  *(Verified by probe.)*
- **Stripe replay protection is the right shape.** Insert-first on a unique key, with the
  database arbitrating. There is no check-then-act race between two concurrent deliveries.
  *(Verified by probe. Subject to S1-3 — the constraint must actually exist.)*
- **Stripe unknown event types.** Ignored, acknowledged, no error path.
- **Stripe does not trust the event for entitlement.** Client, role and quantity from the
  event are cross-checked against the database row and rejected on mismatch.
- **Agreement token strength and storage.** 256 bits of CSPRNG entropy, stored as a SHA-256
  hash, never in plaintext. Not guessable and not recoverable from a database read.
- **Agreement token comparison.** Indexed equality on a hash. Timing-safe comparison is
  unnecessary here and its absence is not a weakness.
- **Agreement tokens are not in URLs.** Read from the POST body, so no query-string logging
  and no `Referer` leakage from the API.
- **Agreement expiry is server-side**, checked on every use.
- **`GET /:token`** reads no database, logs nothing, cannot enumerate interviews, and does not
  intercept `/healthz` or `/health`.
- **Cron secrets are never accepted in a query string**, and an unset secret fails closed
  rather than matching an empty value.
- **OTP cleanup deletes only used or expired rows**, bounded by a server-generated timestamp.
- **Contract renewals are idempotent when run in sequence.** Only concurrency is a problem
  (S4-2).

---

*No credentials, secrets or token values appear in this document. Findings marked [probe] were
verified by executing the real router with stubbed dependencies; the probe created no files in
the repository and no application code was modified.*

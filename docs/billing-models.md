# Billing models

There are three ways a client can be billed for interviews. Every client is on
exactly one of them, recorded as `billing_model` on their plan settings.

| Model | Who | What happens to unused interviews |
| --- | --- | --- |
| `fixed` | Essentials | Lost when the role closes |
| `rollover` | Pro | Become client credit, usable for 90 days |
| `usage` | Enterprise | Interviews past the included count are invoiced |

A client's model is set from their plan tier when their subscription starts, and
can be changed afterwards by an administrator. Clients whose records predate this
feature behave as their tier implies, so nothing had to be migrated by hand.

---

## What counts as a billable interview

The same definition applies everywhere — capacity limits, credits and Enterprise
invoices all use it, so the three can never disagree.

An interview counts once **any** of these is true:

- its status is `completed` or `analyzed`
- it has an interview summary
- it has a numeric overall transcript score

With one exception that overrides all of the above: an interview where the
candidate never gave a substantive response **does not count**. If a candidate
joins and says nothing usable, the client is not charged for it and it does not
consume their allowance.

An interview can also become billable late — a transcript sometimes arrives after
the interview has ended. That is handled: the interview is charged at most once
no matter how many times its record is updated.

---

## Essentials — the fixed model

Each role gets an allowance of 20 interviews. Additional interviews can be bought
for that role at $30 each, and count toward the same role.

When the role is closed, any unused part of the allowance is gone. Reopening the
role does not bring it back — the allowance is per role, and closing it ends it.

---

## Pro — the rollover model

Each role gets an allowance of 30 interviews, and additional interviews can be
bought at $35 each.

**When a role is closed**, whatever is left of that role's allowance becomes
client credit. Credit is not tied to the role it came from: it can be spent on
any role the client has open. It expires 90 days after the role closed. The
window is configurable per client.

**Closing the same role twice** does not hand out a second credit.

**When a role is reopened**, its own allowance comes back and the credit from
closing it is cancelled — but interviews already spent from that credit are not
taken back from the roles that used them. Instead, the reopened role's allowance
is reduced by the number already spent. If a role closed with 10 left, 3 of those
were spent on other roles, and the role is then reopened, it comes back with 7.

**Which allowance is spent first.** A role always uses what it has of its own —
its included allowance plus anything bought specifically for it — before touching
any credit. Once its own allowance is gone, the next interview draws from the
credit that expires soonest, so nothing lapses unused.

**Capacity warnings.** A role is only reported as full when the client has no
credit left either, so a client holding credit is never told to buy more.

---

## Enterprise — the usage model

Enterprise pricing is set per client: the platform fee, the per-role fee, the
number of interviews included per role, and a per-interview price for anything
beyond it. Any of these may be zero — an Enterprise client can have no included
interviews at all and simply pay per interview.

**What gets billed.** For each role, the included count is free. Every used
interview beyond it is charged at the client's per-interview price. The included
count is per role, not per client.

**When it is billed** depends on how the client pays the platform fee.

- **Monthly clients.** When Stripe opens the next month's draft invoice, the
  usage for the period is added to it as line items before it goes out. The
  client gets one invoice with the platform fee and their usage on it.
- **Annual clients.** Their platform-fee invoice only appears once a year, so a
  scheduled job raises a separate usage invoice each month, on the same day of
  the month their subscription started. If that day does not exist in a given
  month — the 31st in a 30-day month — it runs on the last day instead.

**What the invoice looks like.** One line per role:

```
Interviews — Hygienist (2026-08-01 to 2026-09-01)     12 x $25.00     $300.00
Interviews — Front Desk (2026-08-01 to 2026-09-01)     3 x $25.00      $75.00
```

**An interview is never billed twice.** Each billed interview is recorded
individually, and the database refuses a second record for the same interview.
That holds across retries, redelivered Stripe events, and a re-run of the same
period.

**If no per-interview price is set**, nothing is billed. The system will not
guess a price.

**If Stripe is unavailable part-way through**, the work is already written down
before any charge is created, so the retry picks up exactly the part that did not
finish. Nothing is lost and nothing is charged twice.

**If the invoice has already been finalized** when the usage is calculated, it is
left alone and the usage is carried into the next cycle. This is logged as
`usage_invoice_already_finalized`.

---

## Administrator endpoints

All of these require an authenticated administrator.

### How a client's pricing and model are set

There is no direct edit. Pricing is set on the **membership agreement** — the
Billing → Agreement Generator form in the admin console — and becomes the
client's plan settings only once the client has signed and paid:

1. An administrator generates the agreement
   (`POST /admin/billing/agreements/send`), choosing the membership tier and
   billing option, and for Enterprise the platform fee, per-role fee, included
   interviews per role, additional-interview fee and per-interview usage price.
2. The client opens the signing link, signs, and pays through Stripe checkout.
3. The Stripe subscription webhook writes `client_plan_settings` from the
   agreement's values.

Until step 3 nothing is written, so an agreement that is never paid changes
nothing.

| Field | Meaning | Units |
| --- | --- | --- |
| `per_role_fee` | Charge to open a role | dollars |
| `included_interviews_per_role` | Free interviews per role | count |
| `additional_interview_fee` | Price of a top-up interview | dollars |
| `usage_interview_fee_cents` | Enterprise per-interview price | **cents** |

Note the mixed units: `usage_interview_fee_cents` is in cents, the other money
fields are in dollars. This follows the existing column conventions.

`billing_model` is not a field anyone sets. It is derived from the tier every
time the webhook runs — Essentials → `fixed`, Pro → `rollover`, Enterprise →
`usage`. `rollover_days` is 90 for every client; there is no setting for it.

> **The Agreement Generator form does not yet have a field for the Enterprise
> per-interview usage price.** The backend accepts `usage_interview_fee_cents`
> on the agreement and carries it through to the client's plan settings, but
> the form has no input for it. Until one is added, Enterprise usage cannot be
> priced through the form, and a usage client is billed nothing for overage.

`POST /admin/clients/:id/subscription-checkout` is the other way to start an
Enterprise subscription. It takes the same fields directly in the request body.

### Raise a usage invoice now

```
POST /admin/clients/:id/usage-invoice
Idempotency-Key: <8 to 255 characters; letters, digits and . : _ - >
```

Invoices everything unbilled immediately, rather than waiting for the cycle. This
is the path for a one-time order at signup.

The `Idempotency-Key` header is **required**. Sending the same key twice returns
the first answer rather than raising a second invoice. Sending the same key with
different data is refused.

Returns `{ "skipped": true, "reason": "..." }` when there is nothing to bill.

### Read everything about a client's billing

```
GET /admin/clients/:id/billing-summary
```

Returns the billing model, the plan settings, current credits, unbilled usage,
and the last twelve usage invoices.

---

## Client endpoints

Both require an authenticated client user and return only that client's data.

```
GET /clients/billing/credits
GET /clients/billing/usage
```

`credits` lists unspent credit — the role it came from, how much is left, and
when it expires — soonest to expire first. A client with no credits gets an empty
list, not an error.

`usage` shows what a usage client has run beyond its included counts and not yet
been invoiced for. It is read-only and does not contact Stripe.

`GET /roles` also now returns `own_remaining_interviews`, `credit_interviews` and
`billing_model` for each role, alongside the counts it already returned.

---

## Configuration required before this works

### 1. Stripe webhook subscription

The Stripe webhook endpoint **must be subscribed to `invoice.created`**. It is
not today. Without it, monthly Enterprise clients will not have their usage added
to their invoices.

Add it in the Stripe dashboard under Developers, Webhooks, your endpoint, then
"Select events".

### 2. Environment variable

```
USAGE_BILLING_CRON_SECRET=<a long random value>
```

Used by the monthly usage cron, in the same way as `CONTRACTS_CRON_SECRET`. If it
is unset, the endpoint refuses every request rather than letting them through.

### 3. Scheduled job

```
POST /internal/billing/usage-invoices
Header: x-cron-secret: <USAGE_BILLING_CRON_SECRET>
```

Run this **once a day**. The job itself picks out only the annual Enterprise
clients whose anniversary is that day, so running it daily is correct and running
it twice in a day is harmless.

It always answers `200` with a per-client breakdown, even if an individual client
fails, so that a scheduler does not replay the clients that already succeeded.
Check the `failed` count and the `results` array.

---

## Migrations

Applied in this order:

| File | Adds |
| --- | --- |
| `20260921120000_billing_models.sql` | `billing_model`, `usage_interview_fee_cents` and `rollover_days` on `client_plan_settings`, and backfills each existing client to the model its tier implies |
| `20260921130000_interview_credits.sql` | `interview_credits`, `interview_credit_draws`, and `roles.rollover_drawn_offset` |
| `20260921140000_usage_billing_ledger.sql` | `usage_billing_ledger` |
| `20260921150000_billing_idempotency_keys.sql` | `billing_idempotency_keys` |

All four are safe to run more than once. Every table creation is
`create table if not exists`, every column addition is guarded by an existence
check, and the tier backfill runs only on the migration that introduces the
column — so re-running will not overwrite a model an administrator has since
changed by hand.

All new tables have row-level security enabled and are reachable only by the
service role.

### Rolling back

Rolling back is a configuration change, not a migration.

1. **Stop the charging.** Remove the `invoice.created` subscription from the
   Stripe webhook endpoint and disable the daily usage cron. No further usage is
   billed from that moment.
2. **Stop the credits.** The billing model is derived from the plan tier, so
   there is no setting to flip. The durable rollback is to revert the Billing 2
   and Billing 3 commits. As a stopgap, `update client_plan_settings set
   billing_model = 'fixed'` stops minting and spending immediately — but the
   next subscription webhook for a Pro client will derive `rollover` again, so
   this holds only until that client's subscription next changes.

Once no client is on `rollover` or `usage`, the new columns and tables are inert. Leave them in place: they hold the record of what was
billed and what credit was issued, which is needed to answer questions about past
invoices. Dropping them would discard that history.

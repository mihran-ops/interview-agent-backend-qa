'use strict';

// Usage billing for the Enterprise model.
//
// Enterprise clients pay a platform fee and, beyond a per-role included count,
// a price per interview. This module works out what is owed and records it; it
// does not talk to Stripe.
//
// An interview is billable when it counts as used and reached that state at or
// before the period end. The interviews schema has no completion timestamp — see
// src/services/adminMetricsService.js:267 — so updated_at is the timestamp used.
// It moves for unrelated writes too, which makes period attribution approximate;
// the unique interview_id on the ledger is what actually prevents double
// billing, so an interview landing in the next period is a timing difference,
// never a duplicate charge.

const { isUsedInterviewRow } = require('./roleInterviewAvailability');
const { resolveBillingModel } = require('./billingModel');

const USAGE_BILLING_MODEL = 'usage';

// The columns isUsedInterviewRow reads, plus what the ledger and ordering need.
const INTERVIEW_COLUMNS = [
  'id',
  'role_id',
  'updated_at',
  'status',
  'transcript_scores',
  'interview_summary',
  'has_substantive_response',
  'failure_code',
  'conversation_progress_state'
].join(',');

const EMPTY_USAGE = Object.freeze({ lines: [], total_cents: 0 });

function emptyUsage(reason) {
  return { lines: [], total_cents: 0, reason };
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Newest first, so the interviews that land on this invoice are the most recent
// ones. A row with no timestamp sorts last rather than being dropped.
function byNewestFirst(left, right) {
  const leftAt = toIso(left?.updated_at) || '';
  const rightAt = toIso(right?.updated_at) || '';
  if (leftAt === rightAt) return String(left?.id ?? '') < String(right?.id ?? '') ? 1 : -1;
  return leftAt < rightAt ? 1 : -1;
}

/**
 * What this client owes for interviews beyond its included counts, up to periodEnd.
 * Only the usage model bills; every other model returns no lines.
 */
async function computeUnbilledUsage({ db, clientId, periodEnd, now } = {}) {
  if (!db || !clientId) return emptyUsage('invalid_request');

  const billing = await resolveBillingModel({ db, clientId });
  if (billing.billing_model !== USAGE_BILLING_MODEL) return emptyUsage('billing_model');

  const unitPriceCents = parseWholeNonNegative(billing.usage_interview_fee_cents);
  if (unitPriceCents == null) return emptyUsage('no_usage_price');

  const includedPerRole = parseWholeNonNegative(billing.included_interviews_per_role) ?? 0;
  const cutoff = toIso(periodEnd) || toIso(now) || new Date().toISOString();

  const { data: roleRows, error: rolesError } = await db
    .from('roles')
    .select('id,title')
    .eq('client_id', clientId);
  if (rolesError) throw new Error(rolesError.message || 'Usage billing role lookup failed');
  if (!roleRows || !roleRows.length) return emptyUsage('no_roles');

  const { data: interviewRows, error: interviewsError } = await db
    .from('interviews')
    .select(INTERVIEW_COLUMNS)
    .eq('client_id', clientId)
    .lte('updated_at', cutoff);
  if (interviewsError) throw new Error(interviewsError.message || 'Usage billing interview lookup failed');

  const { data: ledgerRows, error: ledgerError } = await db
    .from('usage_billing_ledger')
    .select('interview_id,role_id')
    .eq('client_id', clientId);
  if (ledgerError) throw new Error(ledgerError.message || 'Usage billing ledger lookup failed');

  const ledgeredInterviewIds = new Set();
  const ledgeredCountByRole = new Map();
  for (const row of (ledgerRows || [])) {
    ledgeredInterviewIds.add(String(row?.interview_id ?? ''));
    const roleId = String(row?.role_id ?? '');
    ledgeredCountByRole.set(roleId, (ledgeredCountByRole.get(roleId) || 0) + 1);
  }

  const usedByRole = new Map();
  for (const row of (interviewRows || [])) {
    if (!isUsedInterviewRow(row)) continue;
    const roleId = String(row?.role_id ?? '');
    if (!usedByRole.has(roleId)) usedByRole.set(roleId, []);
    usedByRole.get(roleId).push(row);
  }

  const lines = [];
  let totalCents = 0;
  for (const role of roleRows) {
    const roleId = String(role?.id ?? '');
    const usedRows = usedByRole.get(roleId) || [];
    const alreadyLedgered = ledgeredCountByRole.get(roleId) || 0;

    // Everything already on the ledger has been paid for, so it is deducted
    // along with the included count rather than billed again.
    const billable = Math.max(0, usedRows.length - includedPerRole - alreadyLedgered);
    if (billable === 0) continue;

    const candidates = usedRows
      .filter((row) => !ledgeredInterviewIds.has(String(row?.id ?? '')))
      .sort(byNewestFirst)
      .slice(0, billable);
    if (!candidates.length) continue;

    const quantity = candidates.length;
    const amountCents = quantity * unitPriceCents;
    totalCents += amountCents;
    lines.push({
      role_id: roleId,
      role_title: String(role?.title || '').trim() || 'Role',
      quantity,
      unit_price_cents: unitPriceCents,
      amount_cents: amountCents,
      interview_ids: candidates.map((row) => String(row.id))
    });
  }

  if (!lines.length) return emptyUsage('nothing_unbilled');
  return { lines, total_cents: totalCents };
}

/**
 * Writes one ledger row per interview on the given lines, leaving billed_at null
 * until the Stripe item exists. An interview already on the ledger is left alone,
 * so a retry re-attaches rather than double billing.
 */
async function recordUsageLines({ db, clientId, lines, stripeInvoiceId, periodStart, periodEnd } = {}) {
  if (!db || !clientId || !Array.isArray(lines) || !lines.length) return { inserted: 0, rows: [] };

  const rows = [];
  for (const line of lines) {
    for (const interviewId of (line?.interview_ids || [])) {
      rows.push({
        client_id: clientId,
        role_id: line.role_id,
        interview_id: interviewId,
        unit_price_cents: line.unit_price_cents,
        stripe_invoice_id: stripeInvoiceId || null,
        period_start: toIso(periodStart),
        period_end: toIso(periodEnd),
        billed_at: null
      });
    }
  }
  if (!rows.length) return { inserted: 0, rows: [] };

  const { data, error } = await db
    .from('usage_billing_ledger')
    .upsert(rows, { onConflict: 'interview_id', ignoreDuplicates: true })
    .select('id,interview_id,role_id');
  if (error) throw new Error(error.message || 'Usage billing ledger write failed');

  const inserted = Array.isArray(data) ? data : [];
  return { inserted: inserted.length, rows: inserted };
}

/** Every ledger row attached to one Stripe invoice. */
async function listLedgerRowsForInvoice({ db, stripeInvoiceId } = {}) {
  if (!db || !stripeInvoiceId) return [];
  const { data, error } = await db
    .from('usage_billing_ledger')
    .select('id,client_id,role_id,interview_id,unit_price_cents,stripe_invoice_item_id,billed_at,period_start,period_end')
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) throw new Error(error.message || 'Usage billing ledger lookup failed');
  return data || [];
}

/** The end of the last period this client was billed for, if any. */
async function findLastBilledPeriodEnd({ db, clientId } = {}) {
  if (!db || !clientId) return null;
  const { data, error } = await db
    .from('usage_billing_ledger')
    .select('period_end')
    .eq('client_id', clientId)
    .not('period_end', 'is', null)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Usage billing period lookup failed');
  return toIso(data?.period_end);
}

/** Stamps the Stripe item and the billing time onto the rows it paid for. */
async function markUsageLinesBilled({ db, interviewIds, stripeInvoiceItemId, billedAt } = {}) {
  if (!db || !Array.isArray(interviewIds) || !interviewIds.length) return 0;
  const { data, error } = await db
    .from('usage_billing_ledger')
    .update({
      stripe_invoice_item_id: stripeInvoiceItemId || null,
      billed_at: toIso(billedAt) || new Date().toISOString()
    })
    .in('interview_id', interviewIds)
    .is('billed_at', null)
    .select('id');
  if (error) throw new Error(error.message || 'Usage billing ledger stamp failed');
  return Array.isArray(data) ? data.length : 0;
}

// Rebuilds invoice lines from ledger rows a previous attempt already reserved,
// so a resumed run bills exactly what was reserved and nothing more.
function linesFromLedgerRows(rows, roleTitleById) {
  const byRole = new Map();
  for (const row of rows) {
    const roleId = String(row?.role_id ?? '');
    if (!byRole.has(roleId)) {
      byRole.set(roleId, {
        role_id: roleId,
        role_title: roleTitleById.get(roleId) || 'Role',
        quantity: 0,
        unit_price_cents: parseWholeNonNegative(row?.unit_price_cents) ?? 0,
        amount_cents: 0,
        interview_ids: []
      });
    }
    const line = byRole.get(roleId);
    line.quantity += 1;
    line.interview_ids.push(String(row.interview_id));
    line.amount_cents = line.quantity * line.unit_price_cents;
  }
  return [...byRole.values()];
}

function periodLabel(periodStart, periodEnd) {
  const format = (value) => {
    const iso = toIso(value);
    return iso ? iso.slice(0, 10) : null;
  };
  const start = format(periodStart);
  const end = format(periodEnd);
  if (start && end) return `${start} to ${end}`;
  return end || start || 'current period';
}

/**
 * Adds one usage item per role to a Stripe invoice and records the ledger.
 *
 * Ordering is what makes a partial failure recoverable: the ledger rows are
 * reserved first with billed_at null, then each Stripe item is created, then the
 * rows it paid for are stamped. A retry finds the reserved rows and creates
 * items only for the ones still unstamped, so nothing is billed twice and
 * nothing is silently dropped.
 *
 * Stripe failures are rethrown so the caller can let Stripe retry.
 */
async function applyUsageToInvoice({
  db, stripe, clientId, customerId, invoiceId, periodStart, periodEnd, metadata, now
} = {}) {
  if (!db || !stripe || !clientId || !invoiceId) {
    return { applied: false, reason: 'invalid_request', items: 0, total_cents: 0 };
  }

  const existing = await listLedgerRowsForInvoice({ db, stripeInvoiceId: invoiceId });
  if (existing.length && existing.every((row) => row.billed_at != null)) {
    return { applied: false, reason: 'already_billed', items: 0, total_cents: 0 };
  }

  const { data: roleRows, error: rolesError } = await db
    .from('roles')
    .select('id,title')
    .eq('client_id', clientId);
  if (rolesError) throw new Error(rolesError.message || 'Usage billing role lookup failed');
  const roleTitleById = new Map((roleRows || []).map((role) => [String(role.id), String(role.title || '').trim() || 'Role']));

  let lines;
  if (existing.length) {
    // Resume: bill exactly what the failed attempt reserved.
    lines = linesFromLedgerRows(existing.filter((row) => row.billed_at == null), roleTitleById);
  } else {
    const usage = await computeUnbilledUsage({ db, clientId, periodEnd, now });
    if (!usage.lines.length) {
      return { applied: false, reason: usage.reason || 'nothing_unbilled', items: 0, total_cents: 0 };
    }
    await recordUsageLines({
      db, clientId, lines: usage.lines, stripeInvoiceId: invoiceId, periodStart, periodEnd
    });
    lines = usage.lines;
  }

  if (!lines.length) return { applied: false, reason: 'nothing_unbilled', items: 0, total_cents: 0 };

  const label = periodLabel(periodStart, periodEnd);
  let items = 0;
  let totalCents = 0;
  for (const line of lines) {
    const item = await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoiceId,
      currency: 'usd',
      unit_amount: line.unit_price_cents,
      quantity: line.quantity,
      description: `Interviews — ${line.role_title} (${label})`,
      metadata: {
        client_id: clientId,
        role_id: line.role_id,
        source: 'usage_billing',
        ...(metadata || {})
      }
    });

    await markUsageLinesBilled({
      db,
      interviewIds: line.interview_ids,
      stripeInvoiceItemId: item?.id || null,
      billedAt: toIso(now) || new Date().toISOString()
    });
    items += 1;
    totalCents += line.amount_cents;
  }

  return { applied: true, items, total_cents: totalCents, lines };
}

module.exports = {
  EMPTY_USAGE,
  USAGE_BILLING_MODEL,
  applyUsageToInvoice,
  computeUnbilledUsage,
  findLastBilledPeriodEnd,
  listLedgerRowsForInvoice,
  markUsageLinesBilled,
  recordUsageLines
};

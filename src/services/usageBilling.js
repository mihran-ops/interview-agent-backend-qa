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

module.exports = {
  EMPTY_USAGE,
  USAGE_BILLING_MODEL,
  computeUnbilledUsage,
  recordUsageLines
};

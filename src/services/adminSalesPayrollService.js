'use strict';

const crypto = require('crypto');
const { formatInTimeZone, fromZonedTime } = require('date-fns-tz');

const COMMISSION_RATE = 0.5;
const DOCUMENT_BUCKET = 'sales-payroll-documents';
const DOCUMENT_URL_TTL_SECONDS = 300;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const RELATED_SALES_LIMIT = 500;
const PAYROLL_TIME_ZONE = trimText(process.env.SALES_PAYROLL_TIME_ZONE, 80) || 'America/Denver';
const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const ADJUSTMENT_TYPES = new Set(['cancellation', 'refund', 'chargeback', 'manual_adjustment']);
const DIRECTIONS = new Set(['deduction', 'credit']);
const SALE_COLUMNS = [
  'id',
  'selected_plan_key',
  'selected_billing_cadence',
  'company_legal_name',
  'company_dba',
  'buyer_first_name',
  'buyer_last_name',
  'buyer_email',
  'created_by_user_id',
  'created_by_email',
  'platform_fee_cents',
  'promotion_discount_cents',
  'activated_at',
].join(',');
const ADJUSTMENT_COLUMNS = [
  'id',
  'sales_rep_user_id',
  'purchase_intent_id',
  'effective_at',
  'adjustment_type',
  'direction',
  'amount_cents',
  'reason',
  'documentation_storage_path',
  'documentation_filename',
  'documentation_content_type',
  'documentation_size_bytes',
  'created_by_email',
  'created_at',
].join(',');
const RELATED_SALE_COLUMNS = [
  'id',
  'company_legal_name',
  'company_dba',
  'buyer_first_name',
  'buyer_last_name',
  'buyer_email',
  'created_by_user_id',
  'created_by_email',
  'activated_at',
].join(',');

function trimText(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function makePayrollError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseDateOnly(value, label) {
  const raw = trimText(value, 10);
  const displayLabel = label === 'date_from' ? 'Start date' : label === 'date_to' ? 'End date' : 'Effective date';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw makePayrollError(400, `invalid_${label}`, `${displayLabel} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw makePayrollError(400, `invalid_${label}`, `${displayLabel} is invalid.`);
  }
  return raw;
}

function defaultDateRange(now = new Date()) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const localDate = formatInTimeZone(safeNow, PAYROLL_TIME_ZONE, 'yyyy-MM-dd');
  return {
    date_from: `${localDate.slice(0, 8)}01`,
    date_to: localDate,
  };
}

function parsePayrollFilters(query = {}, now = new Date()) {
  const defaults = defaultDateRange(now);
  const dateFrom = trimText(query.date_from, 10) || defaults.date_from;
  const dateTo = trimText(query.date_to, 10) || defaults.date_to;
  parseDateOnly(dateFrom, 'date_from');
  parseDateOnly(dateTo, 'date_to');
  const from = fromZonedTime(`${dateFrom}T00:00:00`, PAYROLL_TIME_ZONE);
  const nextDate = new Date(`${dateTo}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const toExclusive = fromZonedTime(`${nextDate.toISOString().slice(0, 10)}T00:00:00`, PAYROLL_TIME_ZONE);
  if (from.getTime() >= toExclusive.getTime()) {
    throw makePayrollError(400, 'invalid_date_range', 'Start date must be on or before end date.');
  }
  const representativeUserId = trimText(query.representative_user_id, 120);
  return {
    date_from: dateFrom,
    date_to: dateTo,
    from_iso: from.toISOString(),
    to_exclusive_iso: toExclusive.toISOString(),
    representative_user_id: representativeUserId || null,
  };
}

function safeCents(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function commissionCents(value) {
  const numeric = Number(value || 0);
  return Math.sign(numeric) * Math.round(Math.abs(numeric) * COMMISSION_RATE);
}

function calculateSaleCommission(row = {}) {
  const cadence = trimText(row.selected_billing_cadence, 20).toLowerCase();
  const multiplier = cadence === 'monthly' ? 12 : 1;
  const grossMembershipCents = safeCents(row.platform_fee_cents) * multiplier;
  const discountCents = Math.min(grossMembershipCents, safeCents(row.promotion_discount_cents) * multiplier);
  const netMembershipCents = Math.max(0, grossMembershipCents - discountCents);
  return {
    annualization_multiplier: multiplier,
    gross_membership_cents: grossMembershipCents,
    discount_cents: discountCents,
    net_membership_cents: netMembershipCents,
    commission_cents: commissionCents(netMembershipCents),
  };
}

function saleLabel(row = {}) {
  const company = trimText(row.company_dba || row.company_legal_name, 200);
  const buyer = [trimText(row.buyer_first_name, 80), trimText(row.buyer_last_name, 80)].filter(Boolean).join(' ');
  return company || buyer || trimText(row.buyer_email, 254) || 'Membership sale';
}

function repView(row = {}) {
  return {
    user_id: trimText(row.user_id, 120),
    email: trimText(row.email, 254),
    display_name: trimText(row.display_name, 120) || trimText(row.email, 254) || 'Unknown representative',
    active: row.active === true,
  };
}

function saleView(row = {}, repsById = new Map()) {
  const calculated = calculateSaleCommission(row);
  const repId = trimText(row.created_by_user_id, 120);
  const rosteredRep = repsById.get(repId) || null;
  const rep = rosteredRep || {
    user_id: repId,
    email: trimText(row.created_by_email, 254),
    display_name: trimText(row.created_by_email, 254) || 'Unknown representative',
    active: false,
  };
  return {
    id: trimText(row.id, 120),
    activated_at: row.activated_at || null,
    label: saleLabel(row),
    company_name: trimText(row.company_dba || row.company_legal_name, 200),
    buyer_name: [trimText(row.buyer_first_name, 80), trimText(row.buyer_last_name, 80)].filter(Boolean).join(' '),
    buyer_email: trimText(row.buyer_email, 254),
    plan_key: trimText(row.selected_plan_key, 40),
    billing_cadence: trimText(row.selected_billing_cadence, 20),
    representative: rep,
    ...calculated,
    commission_eligible: Boolean(rosteredRep),
    commission_cents: rosteredRep ? calculated.commission_cents : 0,
  };
}

function adjustmentView(row = {}, repsById = new Map(), salesById = new Map()) {
  const amountCents = safeCents(row.amount_cents);
  const direction = trimText(row.direction, 20).toLowerCase();
  const signedMembershipCents = direction === 'credit' ? amountCents : -amountCents;
  const repId = trimText(row.sales_rep_user_id, 120);
  return {
    id: trimText(row.id, 120),
    effective_at: row.effective_at || null,
    adjustment_type: trimText(row.adjustment_type, 40),
    direction,
    amount_cents: amountCents,
    signed_membership_cents: signedMembershipCents,
    commission_impact_cents: commissionCents(signedMembershipCents),
    reason: trimText(row.reason, 2000),
    representative: repsById.get(repId) || { user_id: repId, email: '', display_name: 'Unknown representative', active: false },
    related_sale: salesById.get(trimText(row.purchase_intent_id, 120)) || null,
    document: row.documentation_storage_path ? {
      available: true,
      filename: trimText(row.documentation_filename, 255) || 'Supporting document',
      content_type: trimText(row.documentation_content_type, 160),
      size_bytes: safeCents(row.documentation_size_bytes),
    } : null,
    created_by_email: trimText(row.created_by_email, 254),
    created_at: row.created_at || null,
  };
}

function emptyTotals() {
  return {
    closed_won_count: 0,
    gross_membership_cents: 0,
    discounts_cents: 0,
    net_membership_cents: 0,
    deductions_cents: 0,
    credits_cents: 0,
    adjusted_net_membership_cents: 0,
    commission_cents: 0,
  };
}

function addSaleToTotals(totals, sale) {
  totals.closed_won_count += 1;
  totals.gross_membership_cents += sale.gross_membership_cents;
  totals.discounts_cents += sale.discount_cents;
  totals.net_membership_cents += sale.net_membership_cents;
  totals.commission_cents += sale.commission_cents;
}

function addAdjustmentToTotals(totals, adjustment) {
  if (adjustment.direction === 'credit') totals.credits_cents += adjustment.amount_cents;
  else totals.deductions_cents += adjustment.amount_cents;
  totals.commission_cents += adjustment.commission_impact_cents;
}

function finalizeTotals(totals) {
  totals.adjusted_net_membership_cents = totals.net_membership_cents - totals.deductions_cents + totals.credits_cents;
  return totals;
}

async function readRows(query, code, message) {
  const { data, error } = await query;
  if (error) throw makePayrollError(503, code, message);
  return Array.isArray(data) ? data : [];
}

async function buildAdminSalesPayrollPayload({ db, query = {}, now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') throw makePayrollError(500, 'database_client_required', 'Database client is required.');
  const filters = parsePayrollFilters(query, now);

  const repsPromise = readRows(
    db.from('sales_reps').select('user_id,email,display_name,active,created_at').order('display_name', { ascending: true }),
    'sales_reps_read_failed',
    'Could not load sales representatives.'
  );
  let salesQuery = db.from('public_purchase_intents')
    .select(SALE_COLUMNS)
    .eq('channel', 'sales_assisted')
    .eq('status', 'completed')
    .gte('activated_at', filters.from_iso)
    .lt('activated_at', filters.to_exclusive_iso)
    .order('activated_at', { ascending: false });
  let adjustmentsQuery = db.from('sales_commission_adjustments')
    .select(ADJUSTMENT_COLUMNS)
    .gte('effective_at', filters.from_iso)
    .lt('effective_at', filters.to_exclusive_iso)
    .order('effective_at', { ascending: false });
  let relatedSalesQuery = db.from('public_purchase_intents')
    .select(RELATED_SALE_COLUMNS)
    .eq('channel', 'sales_assisted')
    .eq('status', 'completed')
    .not('activated_at', 'is', null)
    .order('activated_at', { ascending: false })
    .limit(RELATED_SALES_LIMIT);
  if (filters.representative_user_id) {
    salesQuery = salesQuery.eq('created_by_user_id', filters.representative_user_id);
    adjustmentsQuery = adjustmentsQuery.eq('sales_rep_user_id', filters.representative_user_id);
    relatedSalesQuery = relatedSalesQuery.eq('created_by_user_id', filters.representative_user_id);
  }
  const [repRows, saleRows, adjustmentRows, relatedSaleRows] = await Promise.all([
    repsPromise,
    readRows(salesQuery, 'sales_read_failed', 'Could not load completed sales.'),
    readRows(adjustmentsQuery, 'payroll_adjustments_read_failed', 'Could not load payroll adjustments.'),
    readRows(relatedSalesQuery, 'related_sales_read_failed', 'Could not load related sales.'),
  ]);

  const representatives = repRows.map(repView);
  const repsById = new Map(representatives.map((rep) => [rep.user_id, rep]));
  const sales = saleRows.map((row) => saleView(row, repsById));
  const relatedSales = relatedSaleRows.map((row) => {
    const repId = trimText(row.created_by_user_id, 120);
    return {
      id: trimText(row.id, 120),
      label: saleLabel(row),
      activated_at: row.activated_at || null,
      representative: repsById.get(repId) || {
        user_id: repId,
        email: trimText(row.created_by_email, 254),
        display_name: trimText(row.created_by_email, 254) || 'Unknown representative',
        active: false,
      },
    };
  });
  const salesById = new Map([...relatedSales, ...sales].map((sale) => [sale.id, sale]));
  const adjustments = adjustmentRows.map((row) => adjustmentView(row, repsById, salesById));
  const summary = emptyTotals();
  const repTotals = new Map();

  function totalsFor(rep) {
    const key = rep.user_id || rep.email || rep.display_name;
    if (!repTotals.has(key)) repTotals.set(key, { representative: rep, ...emptyTotals() });
    return repTotals.get(key);
  }
  for (const sale of sales) {
    addSaleToTotals(summary, sale);
    addSaleToTotals(totalsFor(sale.representative), sale);
  }
  for (const adjustment of adjustments) {
    addAdjustmentToTotals(summary, adjustment);
    addAdjustmentToTotals(totalsFor(adjustment.representative), adjustment);
  }
  finalizeTotals(summary);
  const byRepresentative = Array.from(repTotals.values())
    .map((entry) => ({ ...entry, ...finalizeTotals(entry) }))
    .sort((left, right) => left.representative.display_name.localeCompare(right.representative.display_name));

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    request_id: requestId,
    commission_rate: COMMISSION_RATE,
    policy: {
      basis: 'net_annual_platform_membership',
      monthly_annualization_multiplier: 12,
      excluded: ['role_fees', 'interview_fees', 'first_role_prepayment'],
      adjustment_period_basis: 'effective_at',
      time_zone: PAYROLL_TIME_ZONE,
      rounding_basis: 'per_record',
    },
    filters: {
      date_from: filters.date_from,
      date_to: filters.date_to,
      representative_user_id: filters.representative_user_id,
    },
    summary,
    representatives,
    by_representative: byRepresentative,
    sales,
    related_sales: relatedSales,
    adjustments,
  };
}

function normalizeAdjustmentInput(body = {}) {
  const salesRepUserId = trimText(body.sales_rep_user_id, 120);
  const purchaseIntentId = trimText(body.purchase_intent_id, 120) || null;
  const adjustmentType = trimText(body.adjustment_type, 40).toLowerCase();
  const direction = trimText(body.direction, 20).toLowerCase();
  const reason = trimText(body.reason, 2000);
  const amountCents = Number(body.amount_cents);
  const effectiveDateText = parseDateOnly(body.effective_date, 'effective_date');
  const effectiveDate = fromZonedTime(`${effectiveDateText}T00:00:00`, PAYROLL_TIME_ZONE);
  if (!salesRepUserId) throw makePayrollError(400, 'sales_rep_required', 'Select a sales representative.');
  if (!ADJUSTMENT_TYPES.has(adjustmentType)) throw makePayrollError(400, 'invalid_adjustment_type', 'Select a valid adjustment type.');
  if (!DIRECTIONS.has(direction)) throw makePayrollError(400, 'invalid_direction', 'Select credit or deduction.');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw makePayrollError(400, 'invalid_amount', 'Amount must be greater than zero.');
  if (reason.length < 3) throw makePayrollError(400, 'reason_required', 'Enter a reason with at least 3 characters.');
  return {
    sales_rep_user_id: salesRepUserId,
    purchase_intent_id: purchaseIntentId,
    adjustment_type: adjustmentType,
    direction,
    amount_cents: amountCents,
    effective_at: effectiveDate.toISOString(),
    reason,
  };
}

function validateDocument(file) {
  if (!file) return null;
  if (!ALLOWED_DOCUMENT_TYPES.has(trimText(file.mimetype, 160).toLowerCase())) {
    throw makePayrollError(400, 'unsupported_document_type', 'Upload a PDF, image, CSV, Excel, or Word document.');
  }
  if (!file.buffer || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_DOCUMENT_BYTES) {
    throw makePayrollError(400, 'invalid_document_size', 'Supporting document must be between 1 byte and 10 MB.');
  }
  return file;
}

function safeFilename(value) {
  const raw = trimText(value, 180).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return raw || 'supporting-document';
}

async function createSalesPayrollAdjustment({ db, body = {}, file = null, actor = {}, now = new Date() } = {}) {
  if (!db || typeof db.from !== 'function') throw makePayrollError(500, 'database_client_required', 'Database client is required.');
  const normalized = normalizeAdjustmentInput(body);
  const document = validateDocument(file);
  const { data: rep, error: repError } = await db.from('sales_reps')
    .select('user_id,email,display_name,active')
    .eq('user_id', normalized.sales_rep_user_id)
    .maybeSingle();
  if (repError) throw makePayrollError(503, 'sales_rep_read_failed', 'Could not verify the sales representative.');
  if (!rep) throw makePayrollError(400, 'sales_rep_not_found', 'Select an existing sales representative.');

  let relatedSale = null;
  if (normalized.purchase_intent_id) {
    const { data, error } = await db.from('public_purchase_intents')
      .select('id,channel,created_by_user_id,company_legal_name,company_dba')
      .eq('id', normalized.purchase_intent_id)
      .maybeSingle();
    if (error) throw makePayrollError(503, 'related_sale_read_failed', 'Could not verify the related sale.');
    if (!data || data.channel !== 'sales_assisted') throw makePayrollError(400, 'related_sale_not_found', 'Select an existing sales-assisted membership sale.');
    if (trimText(data.created_by_user_id, 120) !== normalized.sales_rep_user_id) {
      throw makePayrollError(400, 'related_sale_rep_mismatch', 'The related sale belongs to a different representative.');
    }
    relatedSale = data;
  }

  const id = crypto.randomUUID();
  let storagePath = null;
  if (document) {
    storagePath = `${normalized.sales_rep_user_id}/${id}/${safeFilename(document.originalname)}`;
    const upload = await db.storage.from(DOCUMENT_BUCKET).upload(storagePath, document.buffer, {
      contentType: document.mimetype,
      upsert: false,
    });
    if (upload.error) throw makePayrollError(503, 'document_upload_failed', 'Could not store the supporting document.');
  }

  const payload = {
    id,
    ...normalized,
    documentation_storage_path: storagePath,
    documentation_filename: document ? trimText(document.originalname, 255) : null,
    documentation_content_type: document ? trimText(document.mimetype, 160) : null,
    documentation_size_bytes: document ? document.size : null,
    created_by_user_id: trimText(actor.id, 120) || null,
    created_by_email: trimText(actor.email, 254) || null,
    created_at: (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()).toISOString(),
  };
  const { data: inserted, error: insertError } = await db.from('sales_commission_adjustments')
    .insert(payload)
    .select(ADJUSTMENT_COLUMNS)
    .single();
  if (insertError) {
    if (storagePath && db.storage?.from) await db.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
    throw makePayrollError(503, 'payroll_adjustment_create_failed', 'Could not save the payroll adjustment.');
  }
  const repMap = new Map([[rep.user_id, repView(rep)]]);
  const salesMap = relatedSale ? new Map([[relatedSale.id, { id: relatedSale.id, label: saleLabel(relatedSale) }]]) : new Map();
  return adjustmentView(inserted || payload, repMap, salesMap);
}

async function createAdjustmentDocumentUrl({ db, adjustmentId } = {}) {
  const id = trimText(adjustmentId, 120);
  if (!id) throw makePayrollError(400, 'adjustment_id_required', 'Adjustment ID is required.');
  const { data, error } = await db.from('sales_commission_adjustments')
    .select('id,documentation_storage_path,documentation_filename')
    .eq('id', id)
    .maybeSingle();
  if (error) throw makePayrollError(503, 'payroll_adjustment_read_failed', 'Could not load the payroll adjustment.');
  if (!data) throw makePayrollError(404, 'payroll_adjustment_not_found', 'Payroll adjustment was not found.');
  if (!data.documentation_storage_path) throw makePayrollError(404, 'payroll_document_not_found', 'This adjustment has no supporting document.');
  const signed = await db.storage.from(DOCUMENT_BUCKET).createSignedUrl(data.documentation_storage_path, DOCUMENT_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) throw makePayrollError(503, 'payroll_document_url_failed', 'Could not open the supporting document.');
  return {
    url: signed.data.signedUrl,
    filename: trimText(data.documentation_filename, 255) || 'Supporting document',
    expires_at: new Date(Date.now() + DOCUMENT_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

function safePayrollErrorBody(error, requestId = null) {
  return {
    error: trimText(error?.code, 80) || 'sales_payroll_failed',
    code: trimText(error?.code, 80) || 'sales_payroll_failed',
    detail: trimText(error?.message, 300) || 'Sales payroll request failed.',
    request_id: requestId,
  };
}

module.exports = {
  ADJUSTMENT_TYPES,
  ALLOWED_DOCUMENT_TYPES,
  COMMISSION_RATE,
  DIRECTIONS,
  DOCUMENT_BUCKET,
  MAX_DOCUMENT_BYTES,
  buildAdminSalesPayrollPayload,
  calculateSaleCommission,
  createAdjustmentDocumentUrl,
  createSalesPayrollAdjustment,
  normalizeAdjustmentInput,
  parsePayrollFilters,
  safePayrollErrorBody,
};

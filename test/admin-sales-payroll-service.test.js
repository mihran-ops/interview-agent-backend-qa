'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminSalesPayrollPayload,
  calculateSaleCommission,
  createAdjustmentDocumentUrl,
  createSalesPayrollAdjustment,
  normalizeAdjustmentInput,
  parsePayrollFilters,
} = require('../src/services/adminSalesPayrollService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ranges = [];
    this.orderField = '';
    this.ascending = true;
    this.insertPayload = null;
    this.singleMode = '';
    this.limitCount = null;
  }

  select() { return this; }
  eq(column, value) { this.filters.push({ column, value: String(value) }); return this; }
  gte(column, value) { this.ranges.push({ column, value: new Date(value).getTime(), type: 'gte' }); return this; }
  lt(column, value) { this.ranges.push({ column, value: new Date(value).getTime(), type: 'lt' }); return this; }
  not(column, operator, value) { this.filters.push({ column, operator, value }); return this; }
  limit(count) { this.limitCount = Number(count); return this; }
  order(column, options = {}) { this.orderField = column; this.ascending = options.ascending === true; return this; }
  insert(payload) { this.insertPayload = { ...payload }; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this.execute(); }
  single() { this.singleMode = 'single'; return this.execute(); }

  execute() {
    if (this.insertPayload) {
      if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
      this.db.tables[this.table].push({ ...this.insertPayload });
      return Promise.resolve({ data: { ...this.insertPayload }, error: null });
    }
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      rows = rows.filter((row) => filter.operator === 'is' && filter.value == null
        ? row[filter.column] != null
        : String(row[filter.column] || '') === filter.value);
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        return range.type === 'gte' ? value >= range.value : value < range.value;
      });
    }
    if (this.orderField) {
      rows.sort((left, right) => {
        const comparison = String(left[this.orderField] || '').localeCompare(String(right[this.orderField] || ''));
        return this.ascending ? comparison : -comparison;
      });
    }
    if (Number.isFinite(this.limitCount)) rows = rows.slice(0, this.limitCount);
    if (this.singleMode) return Promise.resolve({ data: rows[0] || null, error: null });
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try { resolve(this.execute()); } catch (error) { reject(error); }
  }
}

function makeDb(tables = {}) {
  const storageFiles = new Map();
  return {
    tables: { sales_reps: [], public_purchase_intents: [], sales_commission_adjustments: [], ...tables },
    from(table) { return new FakeQuery(this, table); },
    storage: {
      from(bucket) {
        return {
          async upload(key, buffer, options) { storageFiles.set(`${bucket}/${key}`, { buffer, options }); return { data: { path: key }, error: null }; },
          async remove(keys) { for (const key of keys) storageFiles.delete(`${bucket}/${key}`); return { data: keys, error: null }; },
          async createSignedUrl(key) { return { data: { signedUrl: `https://files.example.test/${bucket}/${key}` }, error: null }; },
        };
      },
    },
    storageFiles,
  };
}

test('sales payroll route is mounted behind both authentication and admin authorization', () => {
  // The admin router lives in src/routes/admin/index.js after the refactor (Step 7).
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'index.js'), 'utf8');
  assert.match(appSource, /router\.use\('\/sales-payroll', requireAuth, requireAdmin, createAdminSalesPayrollRouter\(\{ db: supabaseAdmin \}\)\)/);
});

test('sales payroll migrations keep browser roles denied and grant only required service-role operations', () => {
  const foundation = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260918233000_sales_commission_adjustments.sql'), 'utf8');
  const grant = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260919011500_sales_commission_adjustments_service_grant.sql'), 'utf8');
  assert.match(foundation, /alter table public\.sales_commission_adjustments enable row level security/i);
  assert.match(foundation, /revoke all on table public\.sales_commission_adjustments from anon, authenticated/i);
  assert.match(foundation, /'sales-payroll-documents'[\s\S]*false/i);
  assert.match(grant, /grant select, insert on table public\.sales_commission_adjustments to service_role/i);
  assert.doesNotMatch(grant, /\b(update|delete|truncate)\b/i);
});

test('commission calculation annualizes monthly platform fee and discount and excludes other fees', () => {
  assert.deepEqual(calculateSaleCommission({
    selected_billing_cadence: 'monthly',
    platform_fee_cents: 29900,
    promotion_discount_cents: 2990,
    first_role_prepay_amount_cents: 35900,
    per_role_fee_cents: 39900,
  }), {
    annualization_multiplier: 12,
    gross_membership_cents: 358800,
    discount_cents: 35880,
    net_membership_cents: 322920,
    commission_cents: 161460,
  });
  assert.equal(calculateSaleCommission({
    selected_billing_cadence: 'annual',
    platform_fee_cents: 649900,
    promotion_discount_cents: 49900,
  }).commission_cents, 300000);
});

test('payroll date filters use Denver-local inclusive calendar dates', () => {
  const filters = parsePayrollFilters({ date_from: '2026-09-01', date_to: '2026-09-18' });
  assert.equal(filters.from_iso, '2026-09-01T06:00:00.000Z');
  assert.equal(filters.to_exclusive_iso, '2026-09-19T06:00:00.000Z');
  assert.throws(() => parsePayrollFilters({ date_from: '2026-09-19', date_to: '2026-09-18' }), /Start date must be on or before end date/);
});

test('payroll report groups sales and period adjustments by representative', async () => {
  const repId = '11111111-1111-4111-8111-111111111111';
  const db = makeDb({
    sales_reps: [{ user_id: repId, email: 'rep@example.com', display_name: 'Michael Rep', active: true }],
    public_purchase_intents: [{
      id: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
      channel: 'sales_assisted',
      selected_plan_key: 'basic',
      selected_billing_cadence: 'monthly',
      company_legal_name: 'Acme LLC',
      company_dba: 'Acme',
      buyer_first_name: 'Alex',
      buyer_last_name: 'Buyer',
      buyer_email: 'alex@example.com',
      created_by_user_id: repId,
      created_by_email: 'rep@example.com',
      platform_fee_cents: 29900,
      promotion_discount_cents: 2990,
      activated_at: '2026-09-05T18:00:00.000Z',
    }],
    sales_commission_adjustments: [
      { id: 'deduction', sales_rep_user_id: repId, purchase_intent_id: '22222222-2222-4222-8222-222222222222', effective_at: '2026-09-10T06:00:00.000Z', adjustment_type: 'refund', direction: 'deduction', amount_cents: 10000, reason: 'Partial refund', created_at: '2026-09-10T06:00:00.000Z' },
      { id: 'credit', sales_rep_user_id: repId, effective_at: '2026-09-12T06:00:00.000Z', adjustment_type: 'manual_adjustment', direction: 'credit', amount_cents: 5000, reason: 'Correction', created_at: '2026-09-12T06:00:00.000Z' },
    ],
  });

  const result = await buildAdminSalesPayrollPayload({ db, query: { date_from: '2026-09-01', date_to: '2026-09-18' } });
  assert.equal(result.summary.closed_won_count, 1);
  assert.equal(result.summary.gross_membership_cents, 358800);
  assert.equal(result.summary.discounts_cents, 35880);
  assert.equal(result.summary.deductions_cents, 10000);
  assert.equal(result.summary.credits_cents, 5000);
  assert.equal(result.summary.adjusted_net_membership_cents, 317920);
  assert.equal(result.summary.commission_cents, 158960);
  assert.equal(result.by_representative[0].commission_cents, 158960);
  assert.equal(result.related_sales[0].label, 'Acme');
  assert.equal(result.adjustments.find((row) => row.id === 'deduction').related_sale.label, 'Acme');
  assert.deepEqual(result.policy.excluded, ['role_fees', 'interview_fees', 'first_role_prepayment']);
});

test('commission totals sum record-level rounded values exactly across representatives', async () => {
  const repA = '11111111-1111-4111-8111-111111111111';
  const repB = '22222222-2222-4222-8222-222222222222';
  const db = makeDb({
    sales_reps: [
      { user_id: repA, email: 'a@example.com', display_name: 'Rep A', active: true },
      { user_id: repB, email: 'b@example.com', display_name: 'Rep B', active: true },
    ],
    sales_commission_adjustments: [
      { id: 'a', sales_rep_user_id: repA, effective_at: '2026-09-10T06:00:00.000Z', adjustment_type: 'manual_adjustment', direction: 'credit', amount_cents: 1, reason: 'One cent A', created_at: '2026-09-10T06:00:00.000Z' },
      { id: 'b', sales_rep_user_id: repB, effective_at: '2026-09-10T06:00:00.000Z', adjustment_type: 'manual_adjustment', direction: 'credit', amount_cents: 1, reason: 'One cent B', created_at: '2026-09-10T06:00:00.000Z' },
    ],
  });
  const result = await buildAdminSalesPayrollPayload({ db, query: { date_from: '2026-09-01', date_to: '2026-09-18' } });
  assert.equal(result.summary.commission_cents, 2);
  assert.equal(result.by_representative.reduce((sum, row) => sum + row.commission_cents, 0), 2);
  assert.equal(result.adjustments.reduce((sum, row) => sum + row.commission_impact_cents, 0), 2);
  assert.equal(result.policy.rounding_basis, 'per_record');
});

test('non-rostered admin sales remain visible but do not accrue contractor commission', async () => {
  const db = makeDb({
    public_purchase_intents: [{
      id: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
      channel: 'sales_assisted',
      selected_plan_key: 'pro',
      selected_billing_cadence: 'annual',
      company_legal_name: 'Admin Assisted LLC',
      buyer_email: 'buyer@example.com',
      created_by_user_id: 'admin-user-1',
      created_by_email: 'admin@example.com',
      platform_fee_cents: 649900,
      promotion_discount_cents: 49900,
      activated_at: '2026-09-10T18:00:00.000Z',
    }],
  });

  const result = await buildAdminSalesPayrollPayload({ db, query: { date_from: '2026-09-01', date_to: '2026-09-18' } });
  assert.equal(result.summary.closed_won_count, 1);
  assert.equal(result.summary.net_membership_cents, 600000);
  assert.equal(result.summary.commission_cents, 0);
  assert.equal(result.sales[0].commission_eligible, false);
  assert.equal(result.sales[0].commission_cents, 0);
  assert.equal(result.by_representative[0].commission_cents, 0);
});

test('adjustment validation rejects invalid values and preserves the selected effective date', () => {
  assert.throws(() => normalizeAdjustmentInput({}), /Effective date must use YYYY-MM-DD/);
  const normalized = normalizeAdjustmentInput({
    sales_rep_user_id: 'rep-1',
    adjustment_type: 'chargeback',
    direction: 'deduction',
    amount_cents: '12345',
    effective_date: '2026-09-18',
    reason: 'Processor chargeback received',
  });
  assert.equal(normalized.effective_at, '2026-09-18T06:00:00.000Z');
  assert.equal(normalized.amount_cents, 12345);
});

test('admin can create an adjustment with a private document and obtain a signed URL', async () => {
  const repId = '11111111-1111-4111-8111-111111111111';
  const db = makeDb({ sales_reps: [{ user_id: repId, email: 'rep@example.com', display_name: 'Michael Rep', active: true }] });
  const created = await createSalesPayrollAdjustment({
    db,
    body: {
      sales_rep_user_id: repId,
      adjustment_type: 'refund',
      direction: 'deduction',
      amount_cents: '25000',
      effective_date: '2026-09-18',
      reason: 'Customer refund issued',
    },
    file: { originalname: 'refund receipt.pdf', mimetype: 'application/pdf', size: 4, buffer: Buffer.from('test') },
    actor: { id: 'admin-1', email: 'admin@example.com' },
    now: new Date('2026-09-18T20:00:00.000Z'),
  });
  assert.equal(created.document.filename, 'refund receipt.pdf');
  assert.equal(created.commission_impact_cents, -12500);
  assert.equal(db.storageFiles.size, 1);

  const signed = await createAdjustmentDocumentUrl({ db, adjustmentId: created.id });
  assert.match(signed.url, /^https:\/\/files\.example\.test\/sales-payroll-documents\//);
  assert.equal(signed.filename, 'refund receipt.pdf');
});

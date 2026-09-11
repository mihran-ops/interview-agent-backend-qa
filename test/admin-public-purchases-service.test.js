'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminPublicPurchasesPayload,
  mapPublicPurchaseStatus,
  resendPublicPurchaseAgreementLink,
  resendPublicPurchaseCheckoutLink,
  resendPublicPurchaseSetupEmail,
  resendPublicPurchaseWelcomeEmail,
  safePublicPurchaseActionErrorBody,
} = require('../src/lib/adminPublicPurchasesService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.ranges = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
    this.updatePayload = null;
    this.insertPayload = null;
    this.singleMode = '';
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value: String(value) });
    return this;
  }

  in(column, values) {
    this.inFilters.push({ column, values: new Set((values || []).map((value) => String(value))) });
    return this;
  }

  gte(column, value) {
    this.ranges.push({ type: 'gte', column, value: new Date(value).getTime() });
    return this;
  }

  lte(column, value) {
    this.ranges.push({ type: 'lte', column, value: new Date(value).getTime() });
    return this;
  }

  order(column, options = {}) {
    this.orderField = column;
    this.ascending = options.ascending === true;
    return this;
  }

  limit(count) {
    this.limitCount = Number(count || 0);
    return this;
  }

  update(payload) {
    this.updatePayload = { ...(payload || {}) };
    return this;
  }

  insert(payload) {
    this.insertPayload = Array.isArray(payload) ? payload.map((row) => ({ ...row })) : { ...(payload || {}) };
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  execute() {
    this.db.reads.push(this.table);
    if (this.insertPayload) {
      const rows = Array.isArray(this.insertPayload) ? this.insertPayload : [this.insertPayload];
      if (!this.db.tables[this.table]) this.db.tables[this.table] = [];
      for (const row of rows) this.db.tables[this.table].push({ ...row });
      this.db.writes.push({ table: this.table, type: 'insert', payload: this.insertPayload });
      return { data: Array.isArray(this.insertPayload) ? this.insertPayload : [this.insertPayload], error: null };
    }
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
    }
    for (const filter of this.inFilters) {
      rows = rows.filter((row) => filter.values.has(String(row[filter.column] || '')));
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        if (!Number.isFinite(value)) return false;
        return range.type === 'gte' ? value >= range.value : value <= range.value;
      });
    }
    if (this.orderField) {
      rows.sort((a, b) => {
        const left = String(a[this.orderField] || '');
        const right = String(b[this.orderField] || '');
        return this.ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (this.updatePayload) {
      const tableRows = this.db.tables[this.table] || [];
      const matches = (row) => {
        for (const filter of this.filters) {
          if (String(row[filter.column] || '') !== filter.value) return false;
        }
        for (const filter of this.inFilters) {
          if (!filter.values.has(String(row[filter.column] || ''))) return false;
        }
        for (const range of this.ranges) {
          const value = new Date(row[range.column] || '').getTime();
          if (!Number.isFinite(value)) return false;
          if (range.type === 'gte' && value < range.value) return false;
          if (range.type === 'lte' && value > range.value) return false;
        }
        return true;
      };
      for (const row of tableRows) {
        if (matches(row)) Object.assign(row, this.updatePayload);
      }
      this.db.writes.push({ table: this.table, type: 'update', payload: this.updatePayload });
      rows = tableRows.filter(matches).map((row) => ({ ...row }));
    }
    if (this.limitCount) rows = rows.slice(0, this.limitCount);
    if (this.singleMode === 'maybeSingle') return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function makeDb(tables = {}) {
  return {
    tables: {
      public_purchase_intents: [],
      membership_agreements: [],
      clients: [],
      client_members: [],
      email_delivery_events: [],
      client_role_credits: [],
      ...tables,
    },
    selects: [],
    reads: [],
    writes: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

const NOW = new Date('2026-06-24T12:00:00.000Z');
const silentLogger = { info() {}, warn() {}, error() {} };

function packageSnapshot(plan = 'basic', cadence = 'monthly', firstRolePrepaySelected = false) {
  const isPro = plan === 'pro';
  const isAnnual = cadence === 'annual';
  return {
    plan_key: plan,
    display_name: isPro ? 'Pro' : 'Essential',
    billing_cadence: cadence,
    billing_cadence_display_name: isAnnual ? 'Annual' : 'Monthly',
    platform_fee: isPro ? (isAnnual ? 6499 : 599) : (isAnnual ? 3299 : 299),
    platform_fee_cents: isPro ? (isAnnual ? 649900 : 59900) : (isAnnual ? 329900 : 29900),
    platform_monthly_fee: isPro ? 599 : 299,
    platform_annual_fee: isPro ? 6499 : 3299,
    per_role_fee: isPro ? 699 : 399,
    included_interviews: isPro ? 30 : 20,
    interview_duration_minutes: isPro ? 12 : 10,
    additional_interview_price: isPro ? 35 : 30,
    first_role_prepay: {
      enabled: true,
      credit_type: 'first_role_prepay',
      normal_role_fee_cents: isPro ? 69900 : 39900,
      discounted_credit_amount_cents: isPro ? 62900 : 35900,
      discount_percent: 10,
      non_refundable: true,
      expires: false,
      selected: firstRolePrepaySelected === true,
    },
  };
}

function intent(overrides = {}) {
  return {
    id: overrides.id || 'intent-1',
    status: overrides.status || 'pending',
    selected_plan_key: overrides.plan || 'basic',
    selected_billing_cadence: overrides.cadence || 'monthly',
    package_snapshot: overrides.package_snapshot || packageSnapshot(overrides.plan || 'basic', overrides.cadence || 'monthly', overrides.firstRolePrepaySelected === true),
    first_role_prepay_selected: overrides.firstRolePrepaySelected === true,
    first_role_prepay_amount_cents: overrides.firstRolePrepaySelected === true ? (overrides.plan === 'pro' ? 62900 : 35900) : null,
    first_role_normal_role_fee_cents: overrides.firstRolePrepaySelected === true ? (overrides.plan === 'pro' ? 69900 : 39900) : null,
    first_role_prepay_discount_percent: overrides.firstRolePrepaySelected === true ? 10 : null,
    first_role_prepay_credit_type: overrides.firstRolePrepaySelected === true ? 'first_role_prepay' : null,
    company_legal_name: overrides.company || 'Acme Dental LLC',
    company_dba: overrides.dba || 'Acme Dental',
    buyer_first_name: overrides.first || 'Alex',
    buyer_last_name: overrides.last || 'Buyer',
    buyer_email: overrides.email || 'alex@example.com',
    buyer_phone: '555-0100',
    buyer_title: 'Talent Lead',
    source_path: '/alphascreen/pricing',
    agreement_id: overrides.agreement_id || null,
    stripe_checkout_session_id: overrides.stripe_checkout_session_id || null,
    client_id: overrides.client_id || null,
    expires_at: null,
    created_at: overrides.created_at || '2026-06-24T10:00:00.000Z',
    updated_at: overrides.updated_at || '2026-06-24T10:10:00.000Z',
    raw_payload: { should_not: 'leak' },
  };
}

function agreement(overrides = {}) {
  return {
    id: overrides.id || 'agreement-1',
    client_id: overrides.client_id || null,
    status: overrides.status || 'sent',
    is_current: Object.prototype.hasOwnProperty.call(overrides, 'is_current') ? overrides.is_current : true,
    checkout_status: overrides.checkout_status || null,
    checkout_session_id: overrides.checkout_session_id || null,
    checkout_created_at: overrides.checkout_created_at || null,
    checkout_paid_at: overrides.checkout_paid_at || null,
    client_legal_name: overrides.company || 'Acme Dental LLC',
    dba_trade_name: 'Acme Dental',
    primary_admin_name: 'Alex Buyer',
    admin_email: 'alex@example.com',
    membership_tier: overrides.plan || 'basic',
    billing_option: overrides.cadence || 'monthly',
    sent_at: '2026-06-24T10:20:00.000Z',
    opened_at: overrides.opened_at || null,
    signed_at: overrides.signed_at || null,
    voided_at: overrides.voided_at || null,
    created_at: '2026-06-24T10:15:00.000Z',
    updated_at: '2026-06-24T10:20:00.000Z',
    signer_token_hash: 'do-not-return',
    draft_pdf_path: '/tmp/private.pdf',
  };
}

test('admin public purchases route is registered behind admin auth', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'publicPurchases.js'), 'utf8');
  assert.match(appSource, /router\.get\('\/public-purchases', requireAuth, requireAdmin/);
  assert.match(appSource, /router\.get\('\/public-purchases\/playbook\.pdf', requireAuth, requireAdmin/);
  assert.match(appSource, /router\.post\('\/public-purchases\/:id\/resend-setup-email', requireAuth, requireAdmin/);
  assert.match(appSource, /router\.post\('\/public-purchases\/:id\/resend-welcome-email', requireAuth, requireAdmin/);
  assert.match(appSource, /router\.post\('\/public-purchases\/:id\/resend-agreement-link', requireAuth, requireAdmin/);
  assert.match(appSource, /router\.post\('\/public-purchases\/:id\/resend-checkout-link', requireAuth, requireAdmin/);
  assert.match(appSource, /buildAdminPublicPurchasesPayload/);
  assert.match(appSource, /safePublicPurchasesErrorBody/);
  assert.match(appSource, /safePublicPurchaseActionErrorBody/);
  assert.match(appSource, /Content-Type', 'application\/pdf'/);
  assert.match(appSource, /Content-Disposition', 'attachment; filename="alphascreen-public-purchase-support-playbook\.pdf"'/);
  assert.match(appSource, /Cache-Control', 'private, no-store'/);
});

test('public purchase status mapping covers key workflow states', () => {
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'pending' } }).key, 'signup_started');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'agreement_pending' }, agreement: { status: 'sent' } }).key, 'agreement_pending');
  assert.equal(mapPublicPurchaseStatus({ agreement: { status: 'signed' } }).key, 'signed_unpaid');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'checkout_pending' }, agreement: { checkout_status: 'pending_payment' } }).key, 'checkout_pending');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'completed' }, agreement: { checkout_status: 'paid' }, client: { billing_status: 'active', subscription_status: 'active' } }).key, 'setup_pending');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'completed' }, agreement: { checkout_status: 'paid' }, client: { billing_status: 'active', subscription_status: 'active' }, member: { user_id: 'user-1' } }).key, 'completed');
  assert.equal(mapPublicPurchaseStatus({ client: { billing_status: 'active', subscription_status: 'past_due' } }).key, 'failed_payment');
  assert.equal(mapPublicPurchaseStatus({ intent: { status: 'canceled' } }).key, 'canceled');
});

test('admin public purchases payload summarizes rows and returns sanitized details', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-started', status: 'pending', created_at: '2026-06-24T10:00:00.000Z' }),
      intent({ id: 'intent-agreement', status: 'agreement_pending', agreement_id: 'agreement-sent', created_at: '2026-06-24T09:00:00.000Z' }),
      intent({ id: 'intent-checkout', status: 'checkout_pending', agreement_id: 'agreement-checkout', client_id: 'client-checkout', created_at: '2026-06-24T08:00:00.000Z' }),
      intent({ id: 'intent-complete', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-paid', client_id: 'client-paid', firstRolePrepaySelected: true, created_at: '2026-06-24T07:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-sent', status: 'sent' }),
      agreement({ id: 'agreement-checkout', status: 'signed', checkout_status: 'pending_payment', checkout_session_id: 'cs_test_checkout', client_id: 'client-checkout', signed_at: '2026-06-24T08:15:00.000Z' }),
      agreement({ id: 'agreement-paid', status: 'signed', checkout_status: 'paid', checkout_session_id: 'cs_test_paid', client_id: 'client-paid', plan: 'pro', cadence: 'annual', signed_at: '2026-06-24T07:15:00.000Z', checkout_paid_at: '2026-06-24T07:30:00.000Z' }),
    ],
    clients: [
      { id: 'client-checkout', name: 'Checkout Co', email: 'alex@example.com', billing_status: 'inactive', subscription_status: 'incomplete', plan_tier: 'basic', billing_interval: 'monthly', stripe_customer_id: 'cus_checkout', stripe_subscription_id: null, created_at: '2026-06-24T08:20:00.000Z' },
      { id: 'client-paid', name: 'Paid Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual', stripe_customer_id: 'cus_paid', stripe_subscription_id: 'sub_paid', created_at: '2026-06-24T07:20:00.000Z' },
    ],
    client_members: [
      { client_id: 'client-paid', user_id: 'user-paid', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin', created_at: '2026-06-24T07:35:00.000Z' },
    ],
    email_delivery_events: [
      {
        id: 'email-1',
        email: 'alex@example.com',
        email_category: 'public_purchase_welcome',
        status: 'sent',
        event_type: 'outbound_public_purchase_welcome',
        event_at: '2026-06-24T07:40:00.000Z',
        created_at: '2026-06-24T07:40:00.000Z',
        is_problem: false,
        custom_args: { purchase_intent_id: 'intent-complete', agreement_id: 'agreement-paid', client_id: 'client-paid' },
        raw_payload: { secret: 'do-not-return' },
      },
    ],
    client_role_credits: [
      {
        id: 'credit-unused',
        billing_client_id: 'client-paid',
        source_client_id: 'client-paid',
        source_public_purchase_intent_id: 'intent-complete',
        source_membership_agreement_id: 'agreement-paid',
        source_stripe_checkout_session_id: 'cs_test_paid',
        credit_type: 'first_role_prepay',
        membership_key: 'pro',
        normal_role_fee_cents: 69900,
        discounted_credit_amount_cents: 62900,
        discount_percent: 10,
        status: 'unused',
        used_at: null,
        used_by_role_id: null,
        created_at: '2026-06-24T07:31:00.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({ db, now: NOW, query: { days: '7', limit: '10' } });

  assert.equal(payload.summary.signup_started, 1);
  assert.equal(payload.summary.agreement_pending, 1);
  assert.equal(payload.summary.checkout_pending, 1);
  assert.equal(payload.summary.completed, 1);
  assert.equal(payload.summary.total, 4);
  assert.equal(payload.purchases.pagination.returned, 4);
  const completed = payload.purchases.items.find((item) => item.purchase_intent_id === 'intent-complete');
  assert.equal(completed.status.key, 'completed');
  assert.equal(completed.membership.key, 'pro');
  assert.equal(completed.membership.billing_cadence, 'annual');
  assert.equal(completed.membership.platform_fee, 6499);
  assert.equal(completed.account_setup.member_user_linked, true);
  assert.equal(completed.email_delivery.welcome_email.status, 'sent');
  assert.equal(completed.first_role_prepay.first_role_prepay_selected, true);
  assert.equal(completed.first_role_prepay.first_role_prepay_amount_cents, 62900);
  assert.equal(completed.first_role_prepay.first_role_normal_role_fee_cents, 69900);
  assert.equal(completed.first_role_prepay.first_role_credit_status, 'unused');
  assert.equal(completed.first_role_prepay.used_by_role_id, null);
  assert.match(completed.support_summary, /First role prepay: Selected - \$629 credit unused/);
  const started = payload.purchases.items.find((item) => item.purchase_intent_id === 'intent-started');
  assert.equal(started.first_role_prepay.first_role_credit_status, 'not_selected');
  assert.match(started.support_summary, /First role prepay: Not selected/);
  assert.deepEqual(Array.from(new Set(db.reads)).sort(), ['client_members', 'client_role_credits', 'clients', 'email_delivery_events', 'membership_agreements', 'public_purchase_intents']);
  assert.equal(db.writes.length, 0);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /raw_payload|signer_token_hash|draft_pdf_path|executed_pdf_path|signature_hash|do-not-return|secret/i);
});

test('admin public purchases filters by status, cadence, membership, search, and paginates', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-basic-monthly', status: 'pending', plan: 'basic', cadence: 'monthly', company: 'Blue Clinic', email: 'blue@example.com', created_at: '2026-06-24T10:00:00.000Z' }),
      intent({ id: 'intent-pro-annual', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-pro', client_id: 'client-pro', company: 'Pro Hospital', email: 'pro@example.com', created_at: '2026-06-24T09:00:00.000Z' }),
      intent({ id: 'intent-pro-annual-2', status: 'completed', plan: 'pro', cadence: 'annual', agreement_id: 'agreement-pro-2', client_id: 'client-pro-2', company: 'Pro Dental', email: 'dental@example.com', created_at: '2026-06-24T08:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-pro', status: 'signed', checkout_status: 'paid', client_id: 'client-pro', plan: 'pro', cadence: 'annual' }),
      agreement({ id: 'agreement-pro-2', status: 'signed', checkout_status: 'paid', client_id: 'client-pro-2', plan: 'pro', cadence: 'annual' }),
    ],
    clients: [
      { id: 'client-pro', name: 'Pro Hospital', email: 'pro@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual' },
      { id: 'client-pro-2', name: 'Pro Dental', email: 'dental@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'pro', billing_interval: 'annual' },
    ],
    client_members: [
      { client_id: 'client-pro', user_id: 'user-pro', email: 'pro@example.com', name: 'Alex Buyer', role: 'admin' },
      { client_id: 'client-pro-2', user_id: 'user-pro-2', email: 'dental@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({
    db,
    now: NOW,
    query: { days: '7', membership: 'pro', cadence: 'annual', status: 'completed', search: 'pro', limit: '1', page: '2' },
  });

  assert.equal(payload.summary.completed, 2);
  assert.equal(payload.purchases.pagination.total, 2);
  assert.equal(payload.purchases.pagination.returned, 1);
  assert.equal(payload.purchases.pagination.page, 2);
  assert.equal(payload.purchases.items.length, 1);
  assert.equal(payload.purchases.items[0].membership.key, 'pro');
  assert.equal(payload.purchases.items[0].membership.billing_cadence, 'annual');
});

test('support summary is returned with safe fields only', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-summary', status: 'pending', agreement_id: 'agreement-summary', created_at: '2026-06-24T10:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-summary', status: 'sent' }),
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({ db, now: NOW, query: { days: '7' } });
  const summary = payload.purchases.items[0].support_summary;
  assert.match(summary, /Purchase intent ID: intent-summary/);
  assert.match(summary, /Agreement ID: agreement-summary/);
  assert.match(summary, /First role prepay: Not selected/);
  assert.match(summary, /buyer signature is pending/i);
  assert.match(summary, /Checkout is unavailable until the agreement is signed/i);
  assert.doesNotMatch(summary, /raw_payload|signer_token|signature_hash|draft_pdf|secret|Bearer/i);
});

test('admin public purchases payload summarizes used first-role prepay credit', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({
        id: 'intent-used-credit',
        status: 'completed',
        plan: 'basic',
        agreement_id: 'agreement-used-credit',
        client_id: 'client-used-credit',
        firstRolePrepaySelected: true,
      }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-used-credit', status: 'signed', checkout_status: 'paid', client_id: 'client-used-credit' }),
    ],
    clients: [
      { id: 'client-used-credit', name: 'Used Credit Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'basic', billing_interval: 'monthly' },
    ],
    client_members: [
      { client_id: 'client-used-credit', user_id: 'user-used-credit', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
    client_role_credits: [
      {
        id: 'credit-used',
        billing_client_id: 'client-used-credit',
        source_client_id: 'client-used-credit',
        source_public_purchase_intent_id: 'intent-used-credit',
        source_membership_agreement_id: 'agreement-used-credit',
        credit_type: 'first_role_prepay',
        membership_key: 'basic',
        normal_role_fee_cents: 39900,
        discounted_credit_amount_cents: 35900,
        discount_percent: 10,
        status: 'used',
        used_by_role_id: 'role-used-credit',
        used_at: '2026-06-25T12:30:00.000Z',
        created_at: '2026-06-24T10:30:00.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({ db, now: NOW, query: { days: '7' } });
  const item = payload.purchases.items[0];

  assert.equal(item.first_role_prepay.first_role_credit_status, 'used');
  assert.equal(item.first_role_prepay.used_by_role_id, 'role-used-credit');
  assert.equal(item.first_role_prepay.used_at, '2026-06-25T12:30:00.000Z');
  assert.match(item.support_summary, /First role prepay: Selected - \$359 credit used by role role-used-credit on 2026-06-25T12:30:00.000Z/);
});

test('agreement-pending row summary and resend action use the same unsigned agreement', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-row-resend', status: 'agreement_pending', agreement_id: 'agreement-row-resend', created_at: '2026-06-24T10:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-row-resend', status: 'sent', checkout_status: null, is_current: false, signed_at: null }),
    ],
  });

  const payload = await buildAdminPublicPurchasesPayload({ db, now: NOW, query: { days: '7' } });
  const row = payload.purchases.items[0];
  assert.equal(row.status.key, 'agreement_pending');
  assert.equal(row.agreement.id, 'agreement-row-resend');
  assert.equal(row.agreement.status, 'sent');
  assert.equal(row.agreement.signed_at, null);
  assert.equal(row.recovery_actions.resend_agreement_link.eligible, true);
  assert.equal(row.recovery_actions.resend_agreement_link.reason, 'eligible');

  const sent = [];
  const result = await resendPublicPurchaseAgreementLink({
    db,
    purchaseIntentId: row.purchase_intent_id,
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore: new Map(),
    sendAgreementEmail: async (to, link) => {
      sent.push({ to, link });
      return { statusCode: 202 };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alex@example.com');
  assert.match(sent[0].link, /\/membership-agreement\/sign\//);
  assert.equal(db.tables.membership_agreements[0].id, 'agreement-row-resend');
  assert.equal(String(db.tables.membership_agreements[0].signer_token_hash || '').length, 64);
  assert.doesNotMatch(JSON.stringify(result), /membership-agreement\/sign|signer_token|tokenHash|raw_payload|secret/i);
});

test('setup email resend is allowed for paid setup-pending purchase and does not expose token', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-setup', status: 'completed', agreement_id: 'agreement-setup', client_id: 'client-setup', created_at: '2026-06-24T10:00:00.000Z' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-setup', status: 'signed', checkout_status: 'paid', client_id: 'client-setup', signed_at: '2026-06-24T10:10:00.000Z', checkout_paid_at: '2026-06-24T10:20:00.000Z' }),
    ],
    clients: [
      { id: 'client-setup', name: 'Setup Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active', plan_tier: 'basic', billing_interval: 'monthly' },
    ],
    client_members: [
      { client_id: 'client-setup', user_id: '', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin', created_at: '2026-06-24T10:25:00.000Z' },
    ],
  });
  const sent = [];
  const result = await resendPublicPurchaseSetupEmail({
    db,
    authAdmin: {},
    purchaseIntentId: 'intent-setup',
    actorEmail: 'admin@example.com',
    requestId: 'req-setup',
    logger: silentLogger,
    rateLimitStore: new Map(),
    ensureRecovery: async () => ({ userId: 'user-setup', actionLink: 'https://setup.example/recovery-token', method: 'recovery' }),
    sendRecoveryEmail: async (to, link, name) => {
      sent.push({ to, link, name });
      return { statusCode: 202 };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(result.recipient, 'alex@example.com');
  assert.equal(sent.length, 1);
  assert.equal(db.tables.client_members[0].user_id, 'user-setup');
  assert.doesNotMatch(JSON.stringify(result), /recovery-token|setup\.example|actionLink|token/i);
});

test('setup email resend rejects unpaid purchase', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-unpaid', status: 'checkout_pending', agreement_id: 'agreement-unpaid', client_id: 'client-unpaid' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-unpaid', status: 'signed', checkout_status: 'pending_payment', client_id: 'client-unpaid', signed_at: '2026-06-24T10:10:00.000Z' }),
    ],
    clients: [
      { id: 'client-unpaid', name: 'Unpaid Co', email: 'alex@example.com', billing_status: 'inactive', subscription_status: 'incomplete' },
    ],
    client_members: [
      { client_id: 'client-unpaid', user_id: 'user-unpaid', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
  });

  await assert.rejects(
    () => resendPublicPurchaseSetupEmail({
      db,
      authAdmin: {},
      purchaseIntentId: 'intent-unpaid',
      actorEmail: 'admin@example.com',
      logger: silentLogger,
      rateLimitStore: new Map(),
      ensureRecovery: async () => ({ userId: 'user-unpaid', actionLink: 'https://setup.example/recovery-token' }),
      sendRecoveryEmail: async () => ({ statusCode: 202 }),
    }),
    /paid public purchase/
  );
});

test('welcome email resend is allowed for completed purchase and records safe email event', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-welcome', status: 'completed', agreement_id: 'agreement-welcome', client_id: 'client-welcome' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-welcome', status: 'signed', checkout_status: 'paid', client_id: 'client-welcome', checkout_paid_at: '2026-06-24T10:20:00.000Z' }),
    ],
    clients: [
      { id: 'client-welcome', name: 'Welcome Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active' },
    ],
    client_members: [
      { client_id: 'client-welcome', user_id: 'user-welcome', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
  });
  const sent = [];
  const result = await resendPublicPurchaseWelcomeEmail({
    db,
    purchaseIntentId: 'intent-welcome',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore: new Map(),
    sendWelcomeEmail: async (to, details) => {
      sent.push({ to, details });
      return { statusCode: 202 };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(result.email_event_recorded, true);
  assert.equal(sent[0].to, 'alex@example.com');
  const emailEvent = db.tables.email_delivery_events[0];
  assert.equal(emailEvent.email_category, 'public_purchase_welcome');
  assert.equal(emailEvent.category, 'admin_public_purchase_welcome_resend');
  assert.equal(emailEvent.custom_args.purchase_intent_id, 'intent-welcome');
  assert.doesNotMatch(JSON.stringify(result), /raw_payload|token|secret|setup\.example/i);
});

test('checkout link resend refreshes signer token, sends email, and returns no link', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-checkout-link', status: 'checkout_pending', agreement_id: 'agreement-checkout-link', client_id: 'client-checkout-link' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-checkout-link', status: 'signed', checkout_status: 'pending_payment', client_id: 'client-checkout-link', signed_at: '2026-06-24T10:10:00.000Z' }),
    ],
    clients: [
      { id: 'client-checkout-link', name: 'Checkout Co', email: 'alex@example.com', billing_status: 'inactive', subscription_status: 'incomplete' },
    ],
  });
  const sent = [];
  const result = await resendPublicPurchaseCheckoutLink({
    db,
    purchaseIntentId: 'intent-checkout-link',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore: new Map(),
    sendCheckoutEmail: async (to, link, name) => {
      sent.push({ to, link, name });
      return { statusCode: 202 };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alex@example.com');
  assert.match(sent[0].link, /\/membership-agreement\/sign\//);
  assert.match(sent[0].link, /checkout=recover/);
  const agreementRow = db.tables.membership_agreements[0];
  assert.equal(String(agreementRow.signer_token_hash || '').length, 64);
  assert.ok(agreementRow.signer_token_expires_at);
  assert.doesNotMatch(JSON.stringify(result), /membership-agreement\/sign|signer_token|tokenHash|raw_payload|secret/i);
});

test('agreement link resend is allowed for sent agreement and returns no link', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-agreement-link', status: 'agreement_pending', agreement_id: 'agreement-link' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-link', status: 'sent', checkout_status: null, is_current: false }),
    ],
  });
  const sent = [];
  const result = await resendPublicPurchaseAgreementLink({
    db,
    purchaseIntentId: 'intent-agreement-link',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore: new Map(),
    sendAgreementEmail: async (to, link, details) => {
      sent.push({ to, link, details });
      return { statusCode: 202 };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(result.recipient, 'alex@example.com');
  assert.equal(result.message, 'Agreement link sent.');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'alex@example.com');
  assert.match(sent[0].link, /\/membership-agreement\/sign\//);
  assert.doesNotMatch(sent[0].link, /checkout=recover/);
  assert.equal(sent[0].details.clientLegalName, 'Acme Dental LLC');
  const agreementRow = db.tables.membership_agreements[0];
  assert.equal(String(agreementRow.signer_token_hash || '').length, 64);
  assert.ok(agreementRow.signer_token_expires_at);
  assert.doesNotMatch(JSON.stringify(result), /membership-agreement\/sign|signer_token|tokenHash|raw_payload|secret/i);
});

test('agreement link resend reports safe send failure and allows retry after failed attempt', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-agreement-fail', status: 'agreement_pending', agreement_id: 'agreement-fail' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-fail', status: 'sent', checkout_status: null, is_current: null }),
    ],
  });
  const rateLimitStore = new Map();
  let sendCount = 0;
  const options = {
    db,
    purchaseIntentId: 'intent-agreement-fail',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore,
    sendAgreementEmail: async () => {
      sendCount += 1;
      return sendCount === 1 ? { skipped: true } : { statusCode: 202 };
    },
  };

  let failure;
  try {
    await resendPublicPurchaseAgreementLink(options);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 'agreement_link_email_send_failed');
  const safeBody = safePublicPurchaseActionErrorBody(failure, 'req-fail');
  assert.equal(safeBody.code, 'agreement_link_email_send_failed');
  assert.match(safeBody.detail, /not configured/i);
  assert.doesNotMatch(JSON.stringify(safeBody), /membership-agreement\/sign|signer_token|tokenHash|raw_payload|secret/i);

  const retry = await resendPublicPurchaseAgreementLink(options);
  assert.equal(retry.sent, true);
  assert.equal(sendCount, 2);
});

test('agreement link resend rejects with safe machine-readable reasons', async () => {
  const cases = [
    {
      name: 'missing agreement',
      message: /does not have an agreement/,
      code: 'agreement_missing',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-missing-agreement', status: 'agreement_pending' })],
      }),
      id: 'intent-missing-agreement',
    },
    {
      name: 'signed',
      message: /before signature/,
      code: 'agreement_already_signed',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-signed-agreement', status: 'signed_unpaid', agreement_id: 'agreement-signed' })],
        membership_agreements: [agreement({ id: 'agreement-signed', status: 'signed', signed_at: '2026-06-24T10:10:00.000Z' })],
      }),
      id: 'intent-signed-agreement',
    },
    {
      name: 'paid',
      message: /completed checkout/,
      code: 'agreement_paid',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-paid-agreement', status: 'completed', agreement_id: 'agreement-paid', client_id: 'client-paid' })],
        membership_agreements: [agreement({ id: 'agreement-paid', status: 'sent', checkout_status: 'paid', checkout_paid_at: '2026-06-24T10:20:00.000Z' })],
      }),
      id: 'intent-paid-agreement',
    },
    {
      name: 'voided',
      message: /voided/,
      code: 'agreement_voided',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-voided-agreement', status: 'canceled', agreement_id: 'agreement-voided' })],
        membership_agreements: [agreement({ id: 'agreement-voided', status: 'voided', voided_at: '2026-06-24T10:20:00.000Z' })],
      }),
      id: 'intent-voided-agreement',
    },
    {
      name: 'canceled',
      message: /canceled/,
      code: 'agreement_canceled',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-canceled-agreement', status: 'canceled', agreement_id: 'agreement-canceled' })],
        membership_agreements: [agreement({ id: 'agreement-canceled', status: 'canceled' })],
      }),
      id: 'intent-canceled-agreement',
    },
    {
      name: 'superseded',
      message: /superseded/,
      code: 'agreement_superseded',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-superseded-agreement', status: 'agreement_pending', agreement_id: 'agreement-superseded' })],
        membership_agreements: [{ ...agreement({ id: 'agreement-superseded', status: 'sent' }), superseded_by_agreement_id: 'agreement-new' }],
      }),
      id: 'intent-superseded-agreement',
    },
    {
      name: 'not pending',
      message: /agreement-pending/,
      code: 'not_agreement_pending',
      db: makeDb({
        public_purchase_intents: [intent({ id: 'intent-draft-agreement', status: 'agreement_pending', agreement_id: 'agreement-draft' })],
        membership_agreements: [agreement({ id: 'agreement-draft', status: 'draft' })],
      }),
      id: 'intent-draft-agreement',
    },
    {
      name: 'recipient missing',
      message: /recipient/,
      code: 'recipient_missing',
      db: makeDb({
        public_purchase_intents: [{ ...intent({ id: 'intent-missing-recipient', status: 'agreement_pending', agreement_id: 'agreement-missing-recipient' }), buyer_email: '' }],
        membership_agreements: [{ ...agreement({ id: 'agreement-missing-recipient', status: 'sent' }), admin_email: '' }],
      }),
      id: 'intent-missing-recipient',
    },
  ];

  for (const item of cases) {
    let failure;
    try {
      await resendPublicPurchaseAgreementLink({
        db: item.db,
        purchaseIntentId: item.id,
        actorEmail: 'admin@example.com',
        logger: silentLogger,
        rateLimitStore: new Map(),
        sendAgreementEmail: async () => ({ statusCode: 202 }),
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, item.name);
    assert.equal(failure.code, item.code, item.name);
    assert.match(failure.message, item.message, item.name);
    const body = safePublicPurchaseActionErrorBody(failure, 'req-ineligible');
    assert.equal(body.code, item.code, item.name);
    assert.doesNotMatch(JSON.stringify(body), /membership-agreement\/sign|signer_token|tokenHash|raw_payload|secret/i);
  }
});

test('checkout link resend rejects unsigned and already-paid agreements', async () => {
  const unsignedDb = makeDb({
    public_purchase_intents: [intent({ id: 'intent-unsigned', status: 'agreement_pending', agreement_id: 'agreement-unsigned' })],
    membership_agreements: [agreement({ id: 'agreement-unsigned', status: 'sent', checkout_status: null })],
  });
  await assert.rejects(
    () => resendPublicPurchaseCheckoutLink({
      db: unsignedDb,
      purchaseIntentId: 'intent-unsigned',
      actorEmail: 'admin@example.com',
      logger: silentLogger,
      rateLimitStore: new Map(),
      sendCheckoutEmail: async () => ({ statusCode: 202 }),
    }),
    /signed current agreement/
  );

  const paidDb = makeDb({
    public_purchase_intents: [intent({ id: 'intent-paid-checkout', status: 'completed', agreement_id: 'agreement-paid-checkout', client_id: 'client-paid-checkout' })],
    membership_agreements: [agreement({ id: 'agreement-paid-checkout', status: 'signed', checkout_status: 'paid', client_id: 'client-paid-checkout' })],
    clients: [{ id: 'client-paid-checkout', billing_status: 'active', subscription_status: 'active' }],
  });
  await assert.rejects(
    () => resendPublicPurchaseCheckoutLink({
      db: paidDb,
      purchaseIntentId: 'intent-paid-checkout',
      actorEmail: 'admin@example.com',
      logger: silentLogger,
      rateLimitStore: new Map(),
      sendCheckoutEmail: async () => ({ statusCode: 202 }),
    }),
    /already completed/
  );
});

test('recovery actions guard rapid duplicate sends', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-rate', status: 'completed', agreement_id: 'agreement-rate', client_id: 'client-rate' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-rate', status: 'signed', checkout_status: 'paid', client_id: 'client-rate' }),
    ],
    clients: [
      { id: 'client-rate', name: 'Rate Co', email: 'alex@example.com', billing_status: 'active', subscription_status: 'active' },
    ],
    client_members: [
      { client_id: 'client-rate', user_id: 'user-rate', email: 'alex@example.com', name: 'Alex Buyer', role: 'admin' },
    ],
  });
  const rateLimitStore = new Map();
  const options = {
    db,
    purchaseIntentId: 'intent-rate',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore,
    sendWelcomeEmail: async () => ({ statusCode: 202 }),
  };

  const first = await resendPublicPurchaseWelcomeEmail(options);
  assert.equal(first.sent, true);
  await assert.rejects(
    () => resendPublicPurchaseWelcomeEmail(options),
    /just sent/
  );
});

test('agreement link resend guards rapid duplicate sends', async () => {
  const db = makeDb({
    public_purchase_intents: [
      intent({ id: 'intent-agreement-rate', status: 'agreement_pending', agreement_id: 'agreement-rate' }),
    ],
    membership_agreements: [
      agreement({ id: 'agreement-rate', status: 'sent' }),
    ],
  });
  const rateLimitStore = new Map();
  let sendCount = 0;
  const options = {
    db,
    purchaseIntentId: 'intent-agreement-rate',
    actorEmail: 'admin@example.com',
    logger: silentLogger,
    rateLimitStore,
    sendAgreementEmail: async () => {
      sendCount += 1;
      return { statusCode: 202 };
    },
  };

  const first = await resendPublicPurchaseAgreementLink(options);
  assert.equal(first.sent, true);
  let failure;
  try {
    await resendPublicPurchaseAgreementLink(options);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 'rate_limited');
  assert.match(failure.message, /just sent/);
  assert.equal(sendCount, 1);
});

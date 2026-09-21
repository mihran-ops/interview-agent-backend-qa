'use strict';

// The billing-model migration, asserted as text.
//
// public.client_plan_settings is not created by any migration in this repository —
// it exists only in the hosted database — so the migration can only be an
// idempotent ALTER and cannot be executed locally. These assertions pin the parts
// that matter: guarded column adds, the constraints, a backfill that runs once,
// and service-role-only access.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260921120000_billing_models.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

test('every column is added behind an existence check', () => {
  for (const column of ['billing_model', 'usage_interview_fee_cents', 'rollover_days']) {
    assert.match(
      sql,
      new RegExp(`column_name = '${column}'[\\s\\S]{0,200}?add column ${column}`, 'i'),
      `${column} must be added only when it does not already exist`
    );
  }
});

test('the new columns carry the defaults the plan specifies', () => {
  assert.match(sql, /add column billing_model text not null default 'fixed'/i);
  assert.match(sql, /add column usage_interview_fee_cents integer/i);
  assert.match(sql, /add column rollover_days integer not null default 90/i);
});

test('each constraint is added only once and allows exactly the intended values', () => {
  assert.match(
    sql,
    /conname = 'client_plan_settings_billing_model_check'[\s\S]*?check \(billing_model in \('fixed', 'rollover', 'usage'\)\)/i
  );
  assert.match(
    sql,
    /conname = 'client_plan_settings_usage_interview_fee_cents_check'[\s\S]*?check \(usage_interview_fee_cents is null or usage_interview_fee_cents >= 0\)/i
  );
  assert.match(
    sql,
    /conname = 'client_plan_settings_rollover_days_check'[\s\S]*?check \(rollover_days > 0\)/i
  );
});

test('the backfill maps each tier to its model and runs only when the column is new', () => {
  assert.match(sql, /if billing_model_added then[\s\S]*?update public\.client_plan_settings/i,
    'a re-run must not overwrite a model an administrator has changed');
  assert.match(sql, /when 'pro' then 'rollover'/i);
  assert.match(sql, /when 'enterprise' then 'usage'/i);
  assert.match(sql, /else 'fixed'/i);
});

test('the table stays row-level secured and service-role only', () => {
  assert.match(sql, /alter table public\.client_plan_settings enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.client_plan_settings\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.client_plan_settings\s*\n?to service_role/i);
});

test('the migration grants nothing to anon or authenticated', () => {
  const grants = sql.match(/grant[\s\S]*?;/gi) || [];
  for (const grant of grants) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i,
      `unexpected non-service-role grant: ${grant}`);
  }
});

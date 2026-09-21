'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260918195401_sales_workspace.sql')
const sql = fs.readFileSync(migrationPath, 'utf8').toLowerCase()
const grantsPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260919143000_sales_workspace_service_grants.sql')
const grantsSql = fs.readFileSync(grantsPath, 'utf8').toLowerCase()

test('sales migration keeps browser access behind service-role routes', () => {
  for (const table of ['sales_reps', 'sales_deal_previews', 'sales_deal_events', 'sales_enterprise_handoffs', 'sales_idempotency_keys']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from anon, authenticated`))
  }
})

test('sales migration adds ownership, GHL, promotion, and payment-start fields', () => {
  for (const field of ['created_by_user_id', 'ghl_contact_id', 'ghl_opportunity_id', 'promotion_code_id', 'term_start_basis', 'activated_at']) {
    assert.match(sql, new RegExp(`add column if not exists ${field}`))
  }
})

test('sales service grants keep browser roles denied and give Express only required operations', () => {
  for (const table of ['sales_reps', 'sales_deal_previews', 'sales_deal_events', 'sales_enterprise_handoffs', 'sales_idempotency_keys']) {
    assert.match(grantsSql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`))
  }
  assert.match(grantsSql, /grant select on table public\.sales_reps to service_role/)
  assert.match(grantsSql, /grant select, insert, update on table public\.sales_deal_previews to service_role/)
  assert.match(grantsSql, /grant select, insert on table public\.sales_deal_events to service_role/)
  assert.match(grantsSql, /grant select, insert on table public\.sales_enterprise_handoffs to service_role/)
  assert.match(grantsSql, /grant select, insert, update, delete on table public\.sales_idempotency_keys to service_role/)
  assert.doesNotMatch(grantsSql, /grant (?:all|[^;]*delete[^;]*) on table public\.sales_deal_previews/)
  assert.doesNotMatch(grantsSql, /grant (?:all|[^;]*update[^;]*|[^;]*delete[^;]*) on table public\.sales_deal_events/)
  assert.doesNotMatch(grantsSql, /grant (?:all|[^;]*update[^;]*|[^;]*delete[^;]*) on table public\.sales_enterprise_handoffs/)
})

test('sales completion migration adds dated agreements, rep Slack mapping, and atomic replacement', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260919161500_sales_completion_tweaks.sql'),
    'utf8'
  )
  for (const field of ['slack_user_id', 'sales_rep_slack_enqueued_at', 'agreement_effective_date', 'agreement_renewal_date', 'agreement_expires_at']) {
    assert.match(sql, new RegExp(field, 'i'))
  }
  assert.match(sql, /create or replace function public\.replace_sales_assisted_agreement/i)
  assert.match(sql, /and agreement_id = p_old_agreement_id/i)
  assert.match(sql, /activation_claimed_at is null/i)
  assert.match(sql, /status = 'superseded'/i)
  assert.match(sql, /revoke all on function public\.replace_sales_assisted_agreement[\s\S]*from public, anon, authenticated/i)
})

'use strict';

// The interview-credits migration, asserted as text.
//
// The two invariants that matter most are structural: one live credit per closed
// role, and one draw per interview. Both are enforced by indexes rather than by
// application code, so they are pinned here.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260921130000_interview_credits.sql');
const sql = fs.readFileSync(MIGRATION, 'utf8');

test('both tables are created idempotently', () => {
  assert.match(sql, /create table if not exists public\.interview_credits/i);
  assert.match(sql, /create table if not exists public\.interview_credit_draws/i);
});

test('a credit cannot be minted with a non-positive quantity or a negative balance', () => {
  assert.match(sql, /constraint interview_credits_quantity_check check \(quantity > 0\)/i);
  assert.match(sql, /constraint interview_credits_remaining_check check \(remaining >= 0\)/i);
});

test('a credit records where it came from and when it lapses', () => {
  for (const column of ['client_id uuid not null', 'source_role_id uuid not null', 'expires_at timestamptz not null', 'revoked_at timestamptz null']) {
    assert.match(sql, new RegExp(column.replace(/ /g, '\\s+'), 'i'), `missing column: ${column}`);
  }
});

test('a closed role can hold only one live credit', () => {
  assert.match(
    sql,
    /create unique index if not exists interview_credits_source_role_uidx[\s\S]*?on public\.interview_credits \(source_role_id\)[\s\S]*?where revoked_at is null/i,
    'a repeated close must not mint a second credit, but a revoked credit must not block a later one'
  );
});

test('an interview can be drawn for exactly once', () => {
  assert.match(sql, /interview_id uuid not null unique/i,
    'a redelivered event or a late transcript must not spend twice');
});

test('a draw points at the credit it came from and dies with it', () => {
  assert.match(sql, /credit_id uuid not null references public\.interview_credits\(id\) on delete cascade/i);
});

test('the indexes the lookups need are present', () => {
  assert.match(sql, /create index if not exists interview_credits_client_expires_at_idx[\s\S]*?\(client_id, expires_at\)/i);
  assert.match(sql, /create index if not exists interview_credit_draws_role_id_idx[\s\S]*?\(role_id\)/i);
});

test('roles gains the drawn offset behind an existence check', () => {
  assert.match(
    sql,
    /column_name = 'rollover_drawn_offset'[\s\S]{0,200}?add column rollover_drawn_offset integer not null default 0/i,
    'public.roles is not created by any migration here, so the column add must be guarded'
  );
});

test('both tables are row-level secured and service-role only', () => {
  assert.match(sql, /alter table public\.interview_credits enable row level security/i);
  assert.match(sql, /alter table public\.interview_credit_draws enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.interview_credits\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /revoke all privileges on table public\.interview_credit_draws\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table[\s\S]*?public\.interview_credits,[\s\S]*?public\.interview_credit_draws[\s\S]*?to service_role/i);
});

test('the migration grants nothing to anon or authenticated', () => {
  const grants = sql.match(/grant[\s\S]*?;/gi) || [];
  for (const grant of grants) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i,
      `unexpected non-service-role grant: ${grant}`);
  }
});

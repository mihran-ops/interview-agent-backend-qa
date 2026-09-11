'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const migration = read('supabase', 'migrations', '20260721160715_interview_recovery_core.sql');
const phaseBMigration = read('supabase', 'migrations', '20260717120000_candidate_incident_phase_b.sql');
const recoveryRoute = read('src', 'routes', 'admin', 'interviewRecovery.js');
const startRoute = read('src', 'routes', 'public', 'createTavusInterview.js');
const reportRoute = read('src', 'routes', 'client', 'reportsPdf.js');
const app = read('app.js');
const adminCandidates = read('src', 'routes', 'admin', 'candidates.js');

test('Recovery Core source 1. migration is additive and does not classify historical interview/report rows', () => {
  const definitionPrefix = migration.slice(0, migration.indexOf('create or replace function'));
  assert.doesNotMatch(definitionPrefix, /update\s+public\.(interviews|reports)\b/i);
  assert.doesNotMatch(definitionPrefix, /delete\s+from\s+public\.(interviews|reports)\b/i);
  assert.doesNotMatch(definitionPrefix, /truncate\s+public\.(interviews|reports)\b/i);
  assert.match(migration, /attempt_mode text null/);
  assert.match(migration, /previous_interview_id/);
  assert.match(migration, /authorize_one_video_replacement/);
});

test('Recovery Core source 2. database constraints cover one authorization, one consumption, exact binding, and immutable links', () => {
  assert.match(migration, /interview_reset_events_one_prior_authorization_uidx/);
  assert.match(migration, /interview_reset_events_one_consumed_prior_uidx/);
  assert.match(phaseBMigration, /interviews_one_active_attempt_uidx/);
  assert.match(migration, /interview_recovery_replacement_binding_mismatch/);
  assert.match(migration, /interview_recovery_replacement_link_immutable/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /request_fingerprint/);
});

test('Recovery Core source 3. security-definer functions are fixed-path and narrowly granted', () => {
  const securityDefiners = migration.match(/security definer/g) || [];
  const fixedPaths = migration.match(/security definer\s+set search_path = ''/g) || [];
  assert.equal(securityDefiners.length, fixedPaths.length);
  for (const name of [
    'get_interview_recovery_core_eligibility',
    'authorize_interview_replacement_core',
    'claim_candidate_interview_attempt_core',
    'complete_interview_recovery_start_core',
    'record_interview_recovery_binding_failure_core',
    'recover_interview_vendor_binding_core',
    'claim_interview_recovery_reconciliation_core',
    'complete_interview_recovery_reconciliation_core',
    'claim_interview_recovery_email_core',
    'complete_interview_recovery_email_core',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[^;]+from public, anon, authenticated`, 'i'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[^;]+to service_role`, 'i'));
  }
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.interview_adjudications from anon, authenticated/);
  assert.match(migration, /revoke all on table private\.interview_vendor_binding_recovery from public, anon, authenticated, service_role/);
});

test('Recovery Core source 4. feature gating fails closed and health exposes only bounded booleans', () => {
  assert.match(recoveryRoute, /router\.use[\s\S]*if \(!featureEnabled\(\)\) return disabledResponse/);
  assert.match(adminCandidates, /interview_recovery_core:\s*isInterviewRecoveryCoreEnabled\(\)/);
  assert.match(app, /interview_recovery_core:\s*\{[\s\S]*enabled: isInterviewRecoveryCoreEnabled\(\),[\s\S]*email_enabled: isInterviewRecoveryCoreEmailEnabled\(\)/);
  assert.match(adminCandidates, /interview_recovery_core_email: isInterviewRecoveryCoreEmailEnabled\(\)/);
  assert.match(recoveryRoute, /resetMode === 'reset_and_send' && !emailFeatureEnabled\(\)/);
  assert.doesNotMatch(app, /interview_recovery_core:[^\n]*process\.env\.INTERVIEW_RECOVERY_CORE_ENABLED/);
});

test('Recovery Core source 5. candidate Start creates only through the claim RPC and records replacement vendor outcomes atomically', () => {
  assert.match(startRoute, /claimInterviewAttempt\(supabaseAdmin/);
  assert.match(startRoute, /claimed\.start_claimed === false/);
  assert.match(startRoute, /completeRecoveryStart\(supabaseAdmin[\s\S]*success: false/);
  assert.match(startRoute, /completeRecoveryStart\(supabaseAdmin[\s\S]*success: true/);
  assert.doesNotMatch(startRoute, /from\('candidates'\)\s*\.insert/);
});

test('Recovery Core source 6. report generation binds recovery artifacts to the exact attempt and keeps legacy URL support', () => {
  assert.match(reportRoute, /recoveryAttempt = !!ivById\.replacement_authorization_id/);
  assert.match(reportRoute, /\.eq\('interview_id', latestInterview\.id\)/);
  assert.match(reportRoute, /report_kind: 'complete_interview'/);
  assert.match(reportRoute, /Resume-only data is the sole candidate-wide input allowed/);
  assert.match(reportRoute, /A bound report carries its own attempt identity/);
  assert.match(reportRoute, /\.eq\('id', reportRow\.interview_id\)/);
  assert.match(reportRoute, /report_interview_binding_mismatch/);
  assert.match(reportRoute, /router\.get\('\/interviews\/:interviewId\/url'/);
  assert.match(reportRoute, /router\.get\('\/:id\/url'/);
});

test('Recovery Core source 7. no excluded B2R question-progress, callback-hardening, or text recovery subsystem is imported', () => {
  const taskFiles = [migration, recoveryRoute];
  for (const source of taskFiles) {
    assert.doesNotMatch(source, /question_plan_snapshot|question_progress|callback_capabilit|encrypted_payload|durable_callback|text_accommodation_recovery/i);
  }
});

test('Recovery Core source 8. ambiguity never becomes vendor-create authorization', () => {
  assert.doesNotMatch(migration, /absence_proven|vendor_retry_authorized|retry_authorized/);
  assert.match(migration, /provider_create_succeeded_bind_failed/);
  assert.match(migration, /vendor_binding_recovery_resolved/);
});

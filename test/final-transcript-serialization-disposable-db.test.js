'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const {
  validateTranscriptScores,
} = require('../src/services/finalTranscriptReconciliation');

const ENABLED = process.env.FINAL_TRANSCRIPT_SERIALIZATION_DISPOSABLE === 'true';
const PREFIX = 'alphascreen_final_transcript_serialization_';
const DATABASE = `${PREFIX}${process.pid}`;
const CONTRACT_PREFIX = 'alphascreen_fts_contract_';
const COMPATIBLE_DATABASE = `${CONTRACT_PREFIX}compatible_${process.pid}`;
const INCOMPATIBLE_DATABASES = new Map([
  ['conversation_type', `${CONTRACT_PREFIX}conversation_type_${process.pid}`],
  ['conversation_nullability', `${CONTRACT_PREFIX}conversation_nullability_${process.pid}`],
  ['conversation_default', `${CONTRACT_PREFIX}conversation_default_${process.pid}`],
  ['conversation_generated', `${CONTRACT_PREFIX}conversation_generated_${process.pid}`],
  ['conversation_identity', `${CONTRACT_PREFIX}conversation_identity_${process.pid}`],
  ['scores_type', `${CONTRACT_PREFIX}scores_type_${process.pid}`],
  ['scores_json', `${CONTRACT_PREFIX}scores_json_${process.pid}`],
  ['scores_nullability', `${CONTRACT_PREFIX}scores_nullability_${process.pid}`],
  ['scores_default', `${CONTRACT_PREFIX}scores_default_${process.pid}`],
  ['scores_generated', `${CONTRACT_PREFIX}scores_generated_${process.pid}`],
  ['scores_identity', `${CONTRACT_PREFIX}scores_identity_${process.pid}`],
  ['scores_domain', `${CONTRACT_PREFIX}scores_domain_${process.pid}`],
  ['questions_type', `${CONTRACT_PREFIX}questions_type_${process.pid}`],
  ['questions_scalar_text', `${CONTRACT_PREFIX}questions_scalar_text_${process.pid}`],
  ['questions_nullability', `${CONTRACT_PREFIX}questions_nullability_${process.pid}`],
  ['questions_default', `${CONTRACT_PREFIX}questions_default_${process.pid}`],
  ['questions_generated', `${CONTRACT_PREFIX}questions_generated_${process.pid}`],
  ['questions_identity', `${CONTRACT_PREFIX}questions_identity_${process.pid}`],
  ['questions_domain', `${CONTRACT_PREFIX}questions_domain_${process.pid}`],
  ['questions_multidimensional', `${CONTRACT_PREFIX}questions_multidimensional_${process.pid}`],
  ['questions_element_type', `${CONTRACT_PREFIX}questions_element_type_${process.pid}`],
  ['summary_type', `${CONTRACT_PREFIX}summary_type_${process.pid}`],
  ['summary_nullability', `${CONTRACT_PREFIX}summary_nullability_${process.pid}`],
  ['summary_default', `${CONTRACT_PREFIX}summary_default_${process.pid}`],
  ['summary_generated', `${CONTRACT_PREFIX}summary_generated_${process.pid}`],
  ['summary_identity', `${CONTRACT_PREFIX}summary_identity_${process.pid}`],
  ['analysis_type', `${CONTRACT_PREFIX}analysis_type_${process.pid}`],
  ['analysis_nullability', `${CONTRACT_PREFIX}analysis_nullability_${process.pid}`],
  ['analysis_default', `${CONTRACT_PREFIX}analysis_default_${process.pid}`],
  ['analysis_generated', `${CONTRACT_PREFIX}analysis_generated_${process.pid}`],
  ['analysis_identity', `${CONTRACT_PREFIX}analysis_identity_${process.pid}`],
]);
const OWNERSHIP_CONTRACT_PREFIX = 'alphascreen_ownership_contract_';
const OWNERSHIP_COMPATIBLE_DATABASE = `${OWNERSHIP_CONTRACT_PREFIX}compatible_${process.pid}`;
const OWNERSHIP_EDGE_DATABASE = `${OWNERSHIP_CONTRACT_PREFIX}edge_${process.pid}`;
const OWNERSHIP_SECURITY_DATABASES = new Map([
  ['rls_disabled', `${OWNERSHIP_CONTRACT_PREFIX}rls_${process.pid}`],
  ['force_rls_disabled', `${OWNERSHIP_CONTRACT_PREFIX}force_${process.pid}`],
  ['service_role_grant', `${OWNERSHIP_CONTRACT_PREFIX}service_acl_${process.pid}`],
  ['public_grant', `${OWNERSHIP_CONTRACT_PREFIX}public_acl_${process.pid}`],
]);
const OWNERSHIP_INCOMPATIBLE_DATABASES = new Map([
  ['missing_column', `${OWNERSHIP_CONTRACT_PREFIX}missing_col_${process.pid}`],
  ['wrong_type', `${OWNERSHIP_CONTRACT_PREFIX}type_${process.pid}`],
  ['wrong_nullability', `${OWNERSHIP_CONTRACT_PREFIX}nullability_${process.pid}`],
  ['wrong_default', `${OWNERSHIP_CONTRACT_PREFIX}default_${process.pid}`],
  ['unexpected_default', `${OWNERSHIP_CONTRACT_PREFIX}extra_default_${process.pid}`],
  ['generated_column', `${OWNERSHIP_CONTRACT_PREFIX}generated_${process.pid}`],
  ['identity_column', `${OWNERSHIP_CONTRACT_PREFIX}identity_${process.pid}`],
  ['unexpected_column', `${OWNERSHIP_CONTRACT_PREFIX}extra_col_${process.pid}`],
  ['missing_primary_key', `${OWNERSHIP_CONTRACT_PREFIX}missing_pk_${process.pid}`],
  ['wrong_primary_key', `${OWNERSHIP_CONTRACT_PREFIX}wrong_pk_${process.pid}`],
  ['wrong_foreign_key', `${OWNERSHIP_CONTRACT_PREFIX}wrong_fk_${process.pid}`],
  ['wrong_foreign_key_delete', `${OWNERSHIP_CONTRACT_PREFIX}wrong_fk_delete_${process.pid}`],
  ['missing_state_check', `${OWNERSHIP_CONTRACT_PREFIX}missing_state_${process.pid}`],
  ['weakened_state_check', `${OWNERSHIP_CONTRACT_PREFIX}weak_state_${process.pid}`],
  ['missing_claim_coherence', `${OWNERSHIP_CONTRACT_PREFIX}missing_claim_${process.pid}`],
  ['missing_analysis_coherence', `${OWNERSHIP_CONTRACT_PREFIX}missing_analysis_${process.pid}`],
  ['wrong_relkind_view', `${OWNERSHIP_CONTRACT_PREFIX}view_${process.pid}`],
  ['wrong_relkind_foreign', `${OWNERSHIP_CONTRACT_PREFIX}foreign_${process.pid}`],
  ['wrong_relkind_partitioned', `${OWNERSHIP_CONTRACT_PREFIX}partitioned_${process.pid}`],
  ['wrong_persistence', `${OWNERSHIP_CONTRACT_PREFIX}unlogged_${process.pid}`],
  ['wrong_owner', `${OWNERSHIP_CONTRACT_PREFIX}owner_${process.pid}`],
  ['unexpected_policy', `${OWNERSHIP_CONTRACT_PREFIX}policy_${process.pid}`],
  ['wrong_required_index', `${OWNERSHIP_CONTRACT_PREFIX}wrong_index_${process.pid}`],
]);
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'interview-recovery-core-disposable-bootstrap.sql');
const PHASE_B = path.join(ROOT, 'supabase', 'migrations', '20260717120000_candidate_incident_phase_b.sql');
const CORE = path.join(ROOT, 'supabase', 'migrations', '20260721160715_interview_recovery_core.sql');
const SERIALIZATION = path.join(ROOT, 'supabase', 'migrations', '20260724142720_final_transcript_reconciliation_serialization.sql');
const DIGEST_SCHEMA_COMPATIBILITY = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260727185302_fix_recovery_digest_schema_compatibility.sql',
);
const OWNERSHIP_TABLE_NAME = 'interview_final_transcript_reconciliation_claims';
const OWNERSHIP_TABLE_QUALIFIED = `private.${OWNERSHIP_TABLE_NAME}`;
const OWNERSHIP_PRIMARY_KEY = 'interview_final_transcript_reconciliation_claims_pkey';
const OWNERSHIP_FOREIGN_KEY =
  'interview_final_transcript_reconciliation_cla_interview_id_fkey';
const OWNERSHIP_PROCESSING_STATE_CHECK =
  'interview_final_transcript_reconciliatio_processing_state_check';
const OWNERSHIP_CLAIM_COHERENCE_CHECK =
  'interview_final_transcript_reconciliation_claims_check';
const OWNERSHIP_ANALYSIS_COHERENCE_CHECK =
  'interview_final_transcript_reconciliation_claims_check2';
const SESSION_DRAIN_TIMEOUT_MS = 3_000;
const SESSION_DRAIN_INTERVAL_MS = 50;
const SESSION_DRAIN_STABLE_ZERO_OBSERVATIONS = 3;
const SAFE_SESSION_STATES = new Set([
  'active',
  'idle',
  'idle in transaction',
  'idle in transaction (aborted)',
  'fastpath function call',
  'disabled',
  'unknown',
]);

let maximumObservedSessionDrainMs = 0;
let maximumObservedSessionDrainAttempts = 0;
let maximumObservedSessionDrainResets = 0;

function extractOwnershipTableCreateSql() {
  const migration = fs.readFileSync(SERIALIZATION, 'utf8');
  const startMarker = `create table if not exists ${OWNERSHIP_TABLE_QUALIFIED} (`;
  const endMarker =
    '\n\n-- Fail closed before defining the RPC boundary';
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return migration
    .slice(start, end)
    .replace('create table if not exists', 'create table');
}

const OWNERSHIP_TABLE_CREATE_SQL = extractOwnershipTableCreateSql();

const ID = {
  client: '77000000-0000-4000-8000-000000000001',
  role: '77000000-0000-4000-8000-000000000002',
  actor: '77000000-0000-4000-8000-000000000003',
};

const ALLOWED_COUNTS = {
  acknowledgment: 0,
  repeat_request: 0,
  hearing_or_audio_issue: 0,
  clarification_request: 0,
  filler: 0,
  silence_or_empty: 0,
  unknown_non_substantive: 0,
  substantive_answer: 1,
};
const STRONG = {
  has_substantive_response: true,
  substantive_response_count: 1,
  candidate_utterance_count: 1,
  candidate_word_count: 10,
  classification_counts: ALLOWED_COUNTS,
  conversation_progress_state: 'CandidateResponded',
};
const STRONGER = {
  has_substantive_response: true,
  substantive_response_count: 2,
  candidate_utterance_count: 2,
  candidate_word_count: 20,
  classification_counts: { ...ALLOWED_COUNTS, substantive_answer: 2 },
  conversation_progress_state: 'CandidateResponded',
};
const SPARSE = {
  has_substantive_response: false,
  substantive_response_count: 0,
  candidate_utterance_count: 1,
  candidate_word_count: 1,
  classification_counts: { ...ALLOWED_COUNTS, acknowledgment: 1, substantive_answer: 0 },
  conversation_progress_state: 'NoSubstantiveCandidateResponse',
};
const VALID_TRANSCRIPT_SCORES = Object.freeze({
  overall: 70,
  role_fit: 70,
  technical_strength: 70,
  communication_quality: 70,
  confidence: 70,
  ai_aided_risk: 'low',
  ai_aided_risk_reason: 'Synthetic evidence.',
});

function transcriptScoreContractVectors() {
  const missingOverall = { ...VALID_TRANSCRIPT_SCORES };
  delete missingOverall.overall;
  return [
    { name: 'valid normal', value: { ...VALID_TRANSCRIPT_SCORES }, valid: true },
    {
      name: 'valid minimum',
      value: {
        ...VALID_TRANSCRIPT_SCORES,
        overall: 0,
        role_fit: 0,
        technical_strength: 0,
        communication_quality: 0,
        confidence: 0,
      },
      valid: true,
    },
    {
      name: 'valid maximum',
      value: {
        ...VALID_TRANSCRIPT_SCORES,
        overall: 100,
        role_fit: 100,
        technical_strength: 100,
        communication_quality: 100,
        confidence: 100,
      },
      valid: true,
    },
    {
      name: 'valid insufficient evidence',
      value: {
        ...VALID_TRANSCRIPT_SCORES,
        overall: null,
        role_fit: null,
        technical_strength: null,
        communication_quality: null,
        confidence: 0,
      },
      valid: true,
    },
    {
      name: 'valid nullable confidence',
      value: { ...VALID_TRANSCRIPT_SCORES, confidence: null },
      valid: true,
    },
    {
      name: 'valid medium enum',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk: 'medium' },
      valid: true,
    },
    {
      name: 'valid high enum',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk: 'high' },
      valid: true,
    },
    {
      name: 'valid empty reason',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk_reason: '' },
      valid: true,
    },
    { name: 'empty object', value: {}, valid: false },
    { name: 'missing key', value: missingOverall, valid: false },
    {
      name: 'unknown key',
      value: { ...VALID_TRANSCRIPT_SCORES, unexpected: true },
      valid: false,
    },
    {
      name: 'wrong type',
      value: { ...VALID_TRANSCRIPT_SCORES, confidence: false },
      valid: false,
    },
    {
      name: 'numeric string',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: '70' },
      valid: false,
    },
    {
      name: 'below minimum',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: -1 },
      valid: false,
    },
    {
      name: 'above maximum',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: 101 },
      valid: false,
    },
    {
      name: 'fraction',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: 70.5 },
      valid: false,
    },
    {
      name: 'invalid enum',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk: 'unknown' },
      valid: false,
    },
    {
      name: 'null non-null field',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk: null },
      valid: false,
    },
    {
      name: 'untrimmed reason',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk_reason: ' untrimmed' },
      valid: false,
    },
    {
      name: 'unicode-untrimmed reason',
      value: { ...VALID_TRANSCRIPT_SCORES, ai_aided_risk_reason: '\u00a0untrimmed' },
      valid: false,
    },
    {
      name: 'mixed nullable scores',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: null },
      valid: false,
    },
    {
      name: 'nested object',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: { value: 70 } },
      valid: false,
    },
    {
      name: 'nested array',
      value: { ...VALID_TRANSCRIPT_SCORES, overall: [70] },
      valid: false,
    },
    {
      name: 'oversized',
      value: {
        ...VALID_TRANSCRIPT_SCORES,
        ai_aided_risk_reason: 'x'.repeat(20000),
      },
      valid: false,
    },
    { name: 'top-level array', value: [], valid: false },
    { name: 'top-level null', value: null, valid: false },
  ];
}

function psqlArgs(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database, '-At'];
}

function sql(statement, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(options.database || DATABASE), '-c', statement], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) assert.fail(result.stderr || result.stdout);
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function databaseCommand(command, database) {
  return spawnSync(command, ['-h', '/tmp', '-p', '5432', database], { encoding: 'utf8' });
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function sleepMilliseconds(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readDatabaseSessionState(database) {
  assert.match(database, /^alphascreen_[a-z0-9_]+_[0-9]+$/);
  const result = spawnSync(
    'psql',
    [
      ...psqlArgs('postgres'),
      '-c',
      `select
        (select count(*)
         from pg_catalog.pg_stat_activity
         where datname=${literal(database)}
           and pid<>pg_backend_pid())::text||'|'||
        coalesce((
          select string_agg(
            distinct coalesce(state,'unknown'),
            ',' order by coalesce(state,'unknown')
          )
          from pg_catalog.pg_stat_activity
          where datname=${literal(database)}
            and pid<>pg_backend_pid()
        ),'')||'|'||
        (select count(*)
         from pg_catalog.pg_prepared_xacts
         where database=${literal(database)})::text||'|'||
        (select count(*)
         from pg_catalog.pg_locks as task_lock
         join pg_catalog.pg_database as task_database
           on task_database.oid=task_lock.database
         where task_database.datname=${literal(database)})::text;`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`database_session_state_read_failed database=${database}`);
  }

  const [
    rawCount,
    rawStates,
    rawPreparedTransactions,
    rawTaskLocks,
  ] = String(result.stdout || '').trim().split('|');
  const count = Number(rawCount);
  const preparedTransactions = Number(rawPreparedTransactions);
  const taskLocks = Number(rawTaskLocks);
  if (![count, preparedTransactions, taskLocks].every(
    (value) => Number.isInteger(value) && value >= 0,
  )) {
    throw new Error(`database_session_state_invalid database=${database}`);
  }
  const states = String(rawStates || '')
    .split(',')
    .filter(Boolean)
    .map((state) => SAFE_SESSION_STATES.has(state) ? state : 'unknown')
    .filter((state, index, values) => values.indexOf(state) === index)
    .sort();
  return { count, states, preparedTransactions, taskLocks };
}

function waitForDatabaseSessionsToDrain(database, options = {}) {
  assert.match(database, /^alphascreen_[a-z0-9_]+_[0-9]+$/);
  const timeoutMs = options.timeoutMs ?? SESSION_DRAIN_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SESSION_DRAIN_INTERVAL_MS;
  const stableZeroObservations =
    options.stableZeroObservations ?? SESSION_DRAIN_STABLE_ZERO_OBSERVATIONS;
  const now = options.now || monotonicMilliseconds;
  const sleep = options.sleep || sleepMilliseconds;
  const readSessionState = options.readSessionState || readDatabaseSessionState;
  const recordObservation = options.recordObservation !== false;
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 5_000);
  assert.ok(Number.isInteger(intervalMs) && intervalMs >= 1 && intervalMs <= 100);
  assert.ok(
    Number.isInteger(stableZeroObservations) &&
      stableZeroObservations >= 2 &&
      stableZeroObservations <= 5,
  );

  const startedAt = now();
  let attempts = 0;
  let consecutiveZeroCount = 0;
  let stableZeroResetCount = 0;
  while (true) {
    attempts += 1;
    const state = readSessionState(database);
    if (!state ||
        !Number.isInteger(state.count) ||
        state.count < 0 ||
        !Array.isArray(state.states) ||
        !Number.isInteger(state.preparedTransactions) ||
        state.preparedTransactions < 0 ||
        !Number.isInteger(state.taskLocks) ||
        state.taskLocks < 0) {
      throw new Error(`database_session_state_invalid database=${database}`);
    }
    const elapsedMs = Math.max(0, now() - startedAt);
    if (recordObservation) {
      maximumObservedSessionDrainMs = Math.max(maximumObservedSessionDrainMs, elapsedMs);
      maximumObservedSessionDrainAttempts = Math.max(
        maximumObservedSessionDrainAttempts,
        attempts,
      );
    }
    if (
      state.count === 0 &&
      state.preparedTransactions === 0 &&
      state.taskLocks === 0
    ) {
      consecutiveZeroCount += 1;
      if (consecutiveZeroCount === stableZeroObservations) {
        if (recordObservation) {
          maximumObservedSessionDrainResets = Math.max(
            maximumObservedSessionDrainResets,
            stableZeroResetCount,
          );
        }
        return {
          elapsedMs,
          attempts,
          consecutiveZeroCount,
          stableZeroResetCount,
          finalSessionState: state,
        };
      }
    } else {
      if (consecutiveZeroCount > 0) {
        stableZeroResetCount += 1;
      }
      consecutiveZeroCount = 0;
    }
    if (elapsedMs >= timeoutMs) {
      const states = state.states
        .map((value) => SAFE_SESSION_STATES.has(value) ? value : 'unknown')
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort();
      throw new Error(
        `database_session_drain_timeout database=${database}` +
        ` remaining_sessions=${state.count}` +
        ` states=${states.join(',') || 'unknown'}` +
        ` consecutive_zero_count=${consecutiveZeroCount}` +
        ` required_stable_zero_count=${stableZeroObservations}` +
        ` elapsed_ms=${elapsedMs}` +
        ` attempts=${attempts}`,
      );
    }
    sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

function cleanupDisposableDatabase(database) {
  assert.match(database, /^alphascreen_[a-z0-9_]+_[0-9]+$/);
  const existsBefore = sql(
    `select count(*) from pg_catalog.pg_database where datname=${literal(database)};`,
    { database: 'postgres' },
  ).stdout;
  assert.equal(existsBefore, '1', `disposable_database_missing database=${database}`);

  const drainResult = waitForDatabaseSessionsToDrain(database);
  assert.equal(
    drainResult.finalSessionState.count,
    0,
    `disposable_database_sessions_remain database=${database}`,
  );
  assert.equal(
    drainResult.consecutiveZeroCount,
    SESSION_DRAIN_STABLE_ZERO_OBSERVATIONS,
    `disposable_database_session_quiescence_incomplete database=${database}`,
  );
  assert.equal(
    drainResult.finalSessionState.preparedTransactions,
    0,
    `disposable_database_prepared_transactions_remain database=${database}`,
  );
  assert.equal(
    drainResult.finalSessionState.taskLocks,
    0,
    `disposable_database_locks_remain database=${database}`,
  );

  const dropped = databaseCommand('dropdb', database);
  const existsAfter = sql(
    `select count(*) from pg_catalog.pg_database where datname=${literal(database)};`,
    { database: 'postgres' },
  ).stdout;
  assert.equal(
    dropped.status,
    0,
    `disposable_database_drop_failed database=${database}`,
  );
  assert.equal(existsAfter, '0', `disposable_database_drop_incomplete database=${database}`);
}

function applyFile(database, filename, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(database), '-f', filename], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) {
    assert.fail(`apply ${path.basename(filename)} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function applyFileTransactional(database, filename, options = {}) {
  const result = spawnSync(
    'psql',
    ['--single-transaction', ...psqlArgs(database), '-f', filename],
    {
      encoding: 'utf8',
      env: { ...process.env, ...(options.env || {}) },
    },
  );
  if (!options.allowFailure && result.status !== 0) {
    assert.fail(`transactional apply ${path.basename(filename)} failed: ${
      result.stderr || result.stdout
    }`);
  }
  return result;
}

function runWithPreservedCleanupFailure(callback, cleanup) {
  let callbackResult;
  let callbackError = null;
  try {
    callbackResult = callback();
  } catch (error) {
    callbackError = error;
  }

  let cleanupError = null;
  try {
    cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (callbackError) {
    if (cleanupError) {
      if (callbackError.cause === undefined) {
        callbackError.cause = cleanupError;
      } else {
        Object.defineProperty(callbackError, 'cleanupError', {
          configurable: true,
          enumerable: false,
          value: cleanupError,
          writable: true,
        });
      }
    }
    throw callbackError;
  }
  if (cleanupError) throw cleanupError;
  return callbackResult;
}

function withDisposableDatabase(database, callback) {
  assert.match(database, /^alphascreen_[a-z0-9_]+_[0-9]+$/);
  assert.equal(sql(
    `select count(*) from pg_database where datname='${database}';`,
    { database: 'postgres' },
  ).stdout, '0');
  const created = databaseCommand('createdb', database);
  assert.equal(created.status, 0, created.stderr);
  return runWithPreservedCleanupFailure(
    callback,
    () => cleanupDisposableDatabase(database),
  );
}

function prepareOwnershipBaseline(database) {
  applyFile(database, BOOTSTRAP);
  applyFile(database, PHASE_B);
  applyFile(database, CORE);
  sql(`
    create schema if not exists private;
    create or replace function private.is_valid_interview_final_transcript_snapshot(
      p_snapshot jsonb
    )
    returns boolean
    language sql
    immutable
    set search_path = ''
    as 'select p_snapshot is not null';
  `, { database });
}

function createExactOwnershipTable(database) {
  sql(OWNERSHIP_TABLE_CREATE_SQL, { database });
}

function ownershipMismatchSql(contract) {
  const statements = new Map([
    ['missing_column', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop column last_released_claim_token;`],
    ['wrong_type', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      alter column claim_token type text using claim_token::text;`],
    ['wrong_nullability', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      alter column claim_token set not null;`],
    ['wrong_default', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      alter column processing_state set default 'claimed';`],
    ['unexpected_default', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      alter column claim_token set default gen_random_uuid();`],
    ['generated_column', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop column last_released_claim_token;
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add column last_released_claim_token uuid
        generated always as ('00000000-0000-4000-8000-000000000001'::uuid) stored;`],
    ['identity_column', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop column analysis_claim_version cascade;
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add column analysis_claim_version bigint generated always as identity;`],
    ['unexpected_column', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add column unexpected_private_metadata text null;`],
    ['missing_primary_key', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_PRIMARY_KEY};`],
    ['wrong_primary_key', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_PRIMARY_KEY};
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add constraint ${OWNERSHIP_PRIMARY_KEY} primary key (claim_version);`],
    ['wrong_foreign_key', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_FOREIGN_KEY};
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add constraint ${OWNERSHIP_FOREIGN_KEY}
        foreign key (interview_id) references public.candidates(id) on delete restrict;`],
    ['wrong_foreign_key_delete', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_FOREIGN_KEY};
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add constraint ${OWNERSHIP_FOREIGN_KEY}
        foreign key (interview_id) references public.interviews(id) on delete cascade;`],
    ['missing_state_check', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_PROCESSING_STATE_CHECK};`],
    ['weakened_state_check', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_PROCESSING_STATE_CHECK};
      alter table ${OWNERSHIP_TABLE_QUALIFIED}
      add constraint ${OWNERSHIP_PROCESSING_STATE_CHECK}
        check (processing_state is not null);`],
    ['missing_claim_coherence', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_CLAIM_COHERENCE_CHECK};`],
    ['missing_analysis_coherence', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_ANALYSIS_COHERENCE_CHECK};`],
    ['wrong_persistence', `alter table ${OWNERSHIP_TABLE_QUALIFIED} set unlogged;`],
    ['wrong_owner', `alter table ${OWNERSHIP_TABLE_QUALIFIED} owner to service_role;`],
    ['unexpected_policy', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      enable row level security;
      create policy unexpected_permissive_policy
      on ${OWNERSHIP_TABLE_QUALIFIED}
      for all to service_role using (true) with check (true);`],
    ['wrong_required_index', `alter table ${OWNERSHIP_TABLE_QUALIFIED}
      drop constraint ${OWNERSHIP_PRIMARY_KEY};
      create unique index ${OWNERSHIP_PRIMARY_KEY}
      on ${OWNERSHIP_TABLE_QUALIFIED} using btree (claim_version);`],
  ]);
  return statements.get(contract);
}

function prepareOwnershipMismatch(database, contract) {
  prepareOwnershipBaseline(database);
  if (contract === 'wrong_relkind_view') {
    sql(`create view ${OWNERSHIP_TABLE_QUALIFIED}
      as select null::uuid as interview_id where false;`, { database });
    return;
  }
  if (contract === 'wrong_relkind_foreign') {
    sql(`create foreign data wrapper ownership_contract_fdw no handler;
      create server ownership_contract_server
        foreign data wrapper ownership_contract_fdw;
      create foreign table ${OWNERSHIP_TABLE_QUALIFIED} (
        interview_id uuid
      ) server ownership_contract_server;`, { database });
    return;
  }
  if (contract === 'wrong_relkind_partitioned') {
    sql(`create table ${OWNERSHIP_TABLE_QUALIFIED} (
      interview_id uuid not null
    ) partition by hash (interview_id);`, { database });
    return;
  }
  createExactOwnershipTable(database);
  sql(ownershipMismatchSql(contract), { database });
}

function ownershipObjectCatalogState(database) {
  return sql(`select
    c.relkind::text||'|'||c.relpersistence::text||'|'||c.relowner::text||'|'||
    c.relrowsecurity::text||'|'||c.relforcerowsecurity::text||'|'||
    (select count(*) from pg_catalog.pg_attribute a
      where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)||'|'||
    (select count(*) from pg_catalog.pg_constraint con
      where con.conrelid=c.oid)||'|'||
    (select count(*) from pg_catalog.pg_index idx
      where idx.indrelid=c.oid)||'|'||
    (select count(*) from pg_catalog.pg_policy pol
      where pol.polrelid=c.oid)||'|'||
    coalesce(c.relacl::text,'')
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relname='${OWNERSHIP_TABLE_NAME}';`, {
    database,
  }).stdout;
}

function literal(value) {
  if (value === null || value === undefined) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return `${literal(JSON.stringify(value))}::jsonb`;
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function candidateId(index) {
  return `77000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`;
}

function interviewId(index) {
  return `77000000-0000-4000-8001-${String(1000 + index).padStart(12, '0')}`;
}

function conversationId(index) {
  return `serialization-conversation-${index}`;
}

function fixture(index, overrides = {}) {
  const transcript = overrides.transcript || `CANDIDATE: I built synthetic system ${index} and improved the project workflow.`;
  return {
    index,
    candidateId: candidateId(index),
    interviewId: interviewId(index),
    conversationId: conversationId(index),
    transcript,
    hash: hash(transcript),
    eventKey: hash(`event-${index}`),
    snapshot: overrides.snapshot || STRONG,
  };
}

function claimSql(item, overrides = {}) {
  return `set role service_role;
    select outcome,coalesce(claim_token::text,''),claim_version,coalesce(scoring_required::text,'')
    from public.claim_interview_final_transcript_reconciliation(
      '${item.interviewId}','${item.conversationId}',
      '${overrides.eventKey || item.eventKey}','${overrides.hash || item.hash}',
      ${json(overrides.snapshot || item.snapshot)},${overrides.leaseSeconds || 60}
    );`;
}

function finalizeSql(item, claim, overrides = {}) {
  const snapshot = overrides.snapshot || item.snapshot;
  const transcript = overrides.transcript || item.transcript;
  const transcriptHash = overrides.hash || item.hash;
  const storageRef = overrides.storageRef ||
    `transcripts/interviews/${item.interviewId}/final-transcripts/${transcriptHash}.txt`;
  const scores = overrides.scores === undefined
    ? {
      overall: 70,
      role_fit: 70,
      technical_strength: 70,
      communication_quality: 70,
      confidence: 70,
      ai_aided_risk: 'low',
      ai_aided_risk_reason: 'Synthetic evidence.',
    }
    : overrides.scores;
  const summary = overrides.summary === undefined ? 'Synthetic scored summary.' : overrides.summary;
  return `set role service_role;
    select outcome,authoritative_snapshot_source,canonical_repair_applied,
      status_before,status_after,progress_before,progress_after
    from public.finalize_interview_final_transcript_reconciliation(
      '${item.interviewId}','${item.conversationId}',
      '${claim.token}',${claim.version},'${overrides.eventKey || item.eventKey}',
      '${transcriptHash}',${literal(storageRef)},${literal(transcript)},
      ${json(snapshot)},${scores === null ? 'null' : json(scores)},${literal(summary)}
    );`;
}

function releaseSql(item, claim, category = 'scoring_failed') {
  return `set role service_role;
    select outcome from public.release_interview_final_transcript_reconciliation(
      '${item.interviewId}','${claim.token}',${claim.version},'${category}'
    );`;
}

function persistQuestionsSql(item, claimVersion, transcriptHash, questions) {
  return `set role service_role;
    select outcome
    from public.persist_interview_unanswered_questions_if_authoritative(
      '${item.interviewId}',${claimVersion},'${transcriptHash}',${json(questions)}
    );`;
}

function analysisV2(index = 1, overrides = {}) {
  return {
    version: 'path_a_v1',
    scores: {
      response_specificity: 70 + index,
      answer_directness: 70,
      answer_consistency: 70,
      communication_structure: 70,
    },
    conditions: {
      evaluation_conditions: 'good',
      audio_quality_issues: 'none',
      distraction_risk: 'low',
      signal_confidence: 'high',
    },
    risk: {
      integrity_risk: 'low',
      reason: 'Synthetic bounded reason.',
    },
    evidence_summary: `Synthetic bounded analysis ${index}.`,
    evidence: ['Synthetic bounded evidence.'],
    limitations: [],
    ...overrides,
  };
}

function claimAnalysisV2Sql(item, transcriptClaimVersion, transcriptHash, leaseSeconds = 300) {
  return `set role service_role;
    select outcome,coalesce(analysis_claim_token::text,''),analysis_claim_version
    from public.claim_interview_analysis_v2_if_authoritative(
      '${item.interviewId}',${transcriptClaimVersion},'${transcriptHash}',${leaseSeconds}
    );`;
}

function finalizeAnalysisV2Sql(item, analysisClaim, transcriptClaimVersion, transcriptHash, analysis) {
  return `set role service_role;
    select outcome
    from public.finalize_interview_analysis_v2_if_authoritative(
      '${item.interviewId}','${analysisClaim.token}',${analysisClaim.version},
      ${transcriptClaimVersion},'${transcriptHash}',${json(analysis)}
    );`;
}

function releaseAnalysisV2Sql(item, analysisClaim, category = 'analysis_generation_failed') {
  return `set role service_role;
    select outcome
    from public.release_interview_analysis_v2_claim(
      '${item.interviewId}','${analysisClaim.token}',${analysisClaim.version},'${category}'
    );`;
}

function parseAnalysisV2Claim(output) {
  const line = String(output).trim().split(/\r?\n/).at(-1);
  const [outcome, token, version] = line.split('|');
  return {
    outcome,
    token,
    version: Number(version),
  };
}

function parseClaim(output) {
  const line = String(output).trim().split(/\r?\n/).at(-1);
  const [outcome, token, version, scoringRequired] = line.split('|');
  return {
    outcome,
    token,
    version: Number(version),
    scoringRequired: scoringRequired === 'true' || scoringRequired === 't',
  };
}

function spawnPsql(database = DATABASE) {
  const child = spawn('psql', psqlArgs(database), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return {
    child,
    write(value) { child.stdin.write(value); },
    end(value = '\\q\n') { child.stdin.end(value); },
    output() { return { stdout: stdout.trim(), stderr: stderr.trim() }; },
    done: new Promise((resolve) => child.once('close', (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }))),
  };
}

async function waitForOutput(session, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.output().stdout.includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${marker}: ${JSON.stringify(session.output())}`);
}

async function concurrentSql(statements) {
  const sessions = statements.map(() => spawnPsql());
  for (const session of sessions) session.write('\\echo READY\n');
  await Promise.all(sessions.map((session) => waitForOutput(session, 'READY')));
  for (let index = 0; index < sessions.length; index += 1) {
    sessions[index].end(`${statements[index]}\n\\q\n`);
  }
  return Promise.all(sessions.map((session) => session.done));
}

async function waitForBlockedQuery(pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = Number(sql(`select count(*) from pg_stat_activity
      where datname=current_database()
        and pid<>pg_backend_pid()
        and query like ${literal(`%${pattern}%`)}
        and wait_event_type='Lock';`).stdout);
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`no lock-waiting query matched ${pattern}`);
}

let baselineInventory = null;

before(() => {
  if (!ENABLED) return;
  assert.match(DATABASE, /^alphascreen_final_transcript_serialization_[0-9]+$/);
  const identity = sql(
    "select current_database()||'|'||current_user||'|'||current_setting('server_version_num');",
    { database: 'postgres' },
  );
  assert.match(identity.stdout, /^postgres\|[^|]+\|17[0-9]{4}$/);
  assert.equal(sql(`select count(*) from pg_database where datname='${DATABASE}';`, { database: 'postgres' }).stdout, '0');
  const created = databaseCommand('createdb', DATABASE);
  assert.equal(created.status, 0, created.stderr);
  applyFile(DATABASE, BOOTSTRAP);
  applyFile(DATABASE, PHASE_B);
  applyFile(DATABASE, CORE);
  sql(`
    create table if not exists public.email_delivery_events (
      id uuid primary key default gen_random_uuid(),
      candidate_id uuid null,
      created_at timestamptz not null default now()
    );
    insert into public.clients(id,name,email,archived_at,access_override_mode)
      values ('${ID.client}','Serialization fixtures','serialization@example.test',null,'inherit');
    insert into public.admins(id,user_id,email,is_active)
      values ('77000000-0000-4000-8000-000000000099','${ID.actor}','admin@example.test',true);
    insert into public.roles(id,client_id,title,slug_or_token,status)
      values ('${ID.role}','${ID.client}','Serialization role','serialization-role','active');
  `);
  for (let index = 1; index <= 45; index += 1) {
    const item = fixture(index);
    const status = index === 18 ? 'Completed' : 'Incomplete';
    const failureCode = index === 19 ? 'INTERVIEW_DISCONNECTED' : 'INTERVIEW_PROGRESS_STALLED';
    sql(`
      insert into public.candidates(id,client_id,role_id,name,email,status,interview_status)
        values ('${item.candidateId}','${ID.client}','${ID.role}','Serialization fixture ${index}',
          'serialization-${index}@example.test','Verified','Incomplete');
      insert into public.interviews(
        id,candidate_id,client_id,role_id,status,attempt_number,is_active,
        tavus_application_id,failure_code,failure_stage,failure_summary,retryable,
        replacement_eligible,has_substantive_response,substantive_response_count,
        candidate_utterance_count,utterance_classification_counts,
        conversation_progress_state
      ) values (
        '${item.interviewId}','${item.candidateId}','${ID.client}','${ID.role}',
        '${status}',1,false,'${item.conversationId}','${failureCode}',
        'live_interview','Synthetic watchdog evidence',true,true,false,0,0,'{}',
        'WaitingForAnswer'
      );
    `);
  }
  const sentinel = fixture(24);
  sql(`
    insert into public.reports(candidate_id,client_id,role_id,interview_id,attempt_number,report_kind)
      values ('${sentinel.candidateId}','${ID.client}','${ID.role}','${sentinel.interviewId}',1,'partial_diagnostic');
    insert into public.otp_tokens(candidate_email,role_id,code,expires_at,used)
      values ('serialization-24@example.test','${ID.role}','000000',now()+interval '1 hour',true);
  `);
  baselineInventory = sql(`select
    (select count(*) from public.interviews)||'|'||
    (select count(*) from public.reports)||'|'||
    (select count(*) from public.interview_reset_events)||'|'||
    (select count(*) from public.interview_adjudications)||'|'||
    (select count(*) from public.interview_admin_audit_logs)||'|'||
    (select count(*) from private.interview_vendor_binding_recovery)||'|'||
    (select count(*) from public.otp_tokens)||'|'||
    (select count(*) from public.email_delivery_events);`).stdout;
});

after(() => {
  if (!ENABLED) return;
  for (const contractDatabase of [
    COMPATIBLE_DATABASE,
    ...INCOMPATIBLE_DATABASES.values(),
    OWNERSHIP_COMPATIBLE_DATABASE,
    OWNERSHIP_EDGE_DATABASE,
    ...OWNERSHIP_SECURITY_DATABASES.values(),
    ...OWNERSHIP_INCOMPATIBLE_DATABASES.values(),
  ]) {
    const exists = sql(
      `select count(*) from pg_database where datname='${contractDatabase}';`,
      { database: 'postgres' },
    ).stdout;
    if (exists === '1') {
      cleanupDisposableDatabase(contractDatabase);
    }
  }
  cleanupDisposableDatabase(DATABASE);
  console.log('[serialization-db] session_drain_summary', {
    timeout_ms: SESSION_DRAIN_TIMEOUT_MS,
    interval_ms: SESSION_DRAIN_INTERVAL_MS,
    stable_zero_observations: SESSION_DRAIN_STABLE_ZERO_OBSERVATIONS,
    maximum_observed_drain_ms: maximumObservedSessionDrainMs,
    maximum_observed_poll_attempts: maximumObservedSessionDrainAttempts,
    maximum_observed_stable_zero_resets: maximumObservedSessionDrainResets,
  });
});

test('serialization session-drain helper is bounded, strict, and diagnostic-safe', async (t) => {
  const database = 'alphascreen_session_drain_999999';
  const sessionState = (count, states = [], overrides = {}) => ({
    count,
    states,
    preparedTransactions: 0,
    taskLocks: 0,
    ...overrides,
  });

  await t.test('requires three interval-separated zero observations', () => {
    let currentTime = 0;
    let reads = 0;
    const sleeps = [];
    const result = waitForDatabaseSessionsToDrain(database, {
      now: () => currentTime,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
      readSessionState: () => {
        reads += 1;
        return sessionState(0);
      },
      recordObservation: false,
    });
    assert.deepEqual(result, {
      elapsedMs: 100,
      attempts: 3,
      consecutiveZeroCount: 3,
      stableZeroResetCount: 0,
      finalSessionState: sessionState(0),
    });
    assert.deepEqual(sleeps, [50, 50]);
    assert.equal(reads, 3);
  });

  await t.test('resets quiescence when a session reappears after one zero', () => {
    let currentTime = 0;
    let reads = 0;
    const sleeps = [];
    const sessionCounts = [0, 1, 0, 0, 0];
    const result = waitForDatabaseSessionsToDrain(database, {
      timeoutMs: 500,
      intervalMs: 50,
      now: () => currentTime,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
      readSessionState: () => sessionState(sessionCounts[reads++] ?? 0, ['idle']),
      recordObservation: false,
    });
    assert.deepEqual(result, {
      elapsedMs: 200,
      attempts: 5,
      consecutiveZeroCount: 3,
      stableZeroResetCount: 1,
      finalSessionState: sessionState(0, ['idle']),
    });
    assert.deepEqual(sleeps, [50, 50, 50, 50]);
    assert.equal(reads, 5);
  });

  await t.test('resets quiescence when a session appears after two zeros', () => {
    let currentTime = 0;
    let reads = 0;
    const sleeps = [];
    const sessionCounts = [0, 0, 1, 0, 0, 0];
    const result = waitForDatabaseSessionsToDrain(database, {
      timeoutMs: 500,
      intervalMs: 50,
      now: () => currentTime,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
      readSessionState: () => sessionState(sessionCounts[reads++] ?? 0, ['idle']),
      recordObservation: false,
    });
    assert.deepEqual(result, {
      elapsedMs: 250,
      attempts: 6,
      consecutiveZeroCount: 3,
      stableZeroResetCount: 1,
      finalSessionState: sessionState(0, ['idle']),
    });
    assert.deepEqual(sleeps, [50, 50, 50, 50, 50]);
    assert.equal(reads, 6);
  });

  await t.test('persistent sessions fail at the bounded deadline', () => {
    let currentTime = 0;
    let reads = 0;
    assert.throws(
      () => waitForDatabaseSessionsToDrain(database, {
        timeoutMs: 100,
        intervalMs: 40,
        now: () => currentTime,
        sleep: (milliseconds) => {
          currentTime += milliseconds;
        },
        readSessionState: () => {
          reads += 1;
          return sessionState(1, ['idle', 'sensitive-application-state']);
        },
        recordObservation: false,
      }),
      (error) => {
        assert.match(
          error.message,
          /^database_session_drain_timeout database=alphascreen_session_drain_999999 /,
        );
        assert.match(error.message, /remaining_sessions=1/);
        assert.match(error.message, /states=idle,unknown/);
        assert.match(error.message, /consecutive_zero_count=0/);
        assert.match(error.message, /required_stable_zero_count=3/);
        assert.match(error.message, /elapsed_ms=100/);
        assert.match(error.message, /attempts=4$/);
        assert.doesNotMatch(error.message, /sensitive-application-state/);
        assert.doesNotMatch(error.message, /query|credential|client|address/i);
        return true;
      },
    );
    assert.equal(reads, 4);
  });

  await t.test('oscillating sessions cannot satisfy stable quiescence', () => {
    let currentTime = 0;
    let reads = 0;
    const sessionCounts = [0, 1, 0, 1];
    assert.throws(
      () => waitForDatabaseSessionsToDrain(database, {
        timeoutMs: 100,
        intervalMs: 40,
        now: () => currentTime,
        sleep: (milliseconds) => {
          currentTime += milliseconds;
        },
        readSessionState: () => sessionState(
          sessionCounts[reads++] ?? 1,
          ['active'],
        ),
        recordObservation: false,
      }),
      (error) => {
        assert.match(error.message, /remaining_sessions=1/);
        assert.match(error.message, /states=active/);
        assert.match(error.message, /consecutive_zero_count=0/);
        assert.match(error.message, /required_stable_zero_count=3/);
        assert.match(error.message, /elapsed_ms=100/);
        assert.match(error.message, /attempts=4$/);
        return true;
      },
    );
    assert.equal(reads, 4);
  });

  await t.test('late task locks reset the same bounded quiescence window', () => {
    let currentTime = 0;
    let reads = 0;
    const lockCounts = [0, 3, 0, 0, 0];
    const result = waitForDatabaseSessionsToDrain(database, {
      timeoutMs: 500,
      intervalMs: 50,
      now: () => currentTime,
      sleep: (milliseconds) => {
        currentTime += milliseconds;
      },
      readSessionState: () => sessionState(0, [], {
        taskLocks: lockCounts[reads++] ?? 0,
      }),
      recordObservation: false,
    });
    assert.deepEqual(result, {
      elapsedMs: 200,
      attempts: 5,
      consecutiveZeroCount: 3,
      stableZeroResetCount: 1,
      finalSessionState: sessionState(0),
    });
    assert.equal(reads, 5);
  });
});

test('serialization cleanup preserves primary failures deterministically', async (t) => {
  await t.test('body failure remains primary when cleanup succeeds', () => {
    const bodyError = new Error('synthetic_body_failure');
    assert.throws(
      () => runWithPreservedCleanupFailure(
        () => { throw bodyError; },
        () => {},
      ),
      (error) => error === bodyError && error.cause === undefined,
    );
  });

  await t.test('cleanup failure is thrown when the body succeeds', () => {
    const cleanupError = new Error('synthetic_cleanup_failure');
    assert.throws(
      () => runWithPreservedCleanupFailure(
        () => 'body-result',
        () => { throw cleanupError; },
      ),
      (error) => error === cleanupError,
    );
  });

  await t.test('body failure remains primary and cleanup is attached as cause', () => {
    const bodyError = new Error('synthetic_body_failure');
    const cleanupError = new Error('synthetic_cleanup_failure');
    assert.throws(
      () => runWithPreservedCleanupFailure(
        () => { throw bodyError; },
        () => { throw cleanupError; },
      ),
      (error) => error === bodyError && error.cause === cleanupError,
    );
  });
});

test('serialization DB 1. migration applies and reapplies without changing historical interviews', { skip: !ENABLED }, () => {
  const before = sql("select md5(string_agg(id::text||coalesce(status,''),'' order by id)) from public.interviews;").stdout;
  applyFile(DATABASE, SERIALIZATION);
  applyFile(DATABASE, SERIALIZATION);
  applyFile(DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
  applyFile(DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
  const afterState = sql("select md5(string_agg(id::text||coalesce(status,''),'' order by id)) from public.interviews;").stdout;
  assert.equal(afterState, before);
  assert.equal(sql(
    "select to_regprocedure('public.digest(bytea,text)') is null;",
  ).stdout, 't');
  assert.equal(sql(
    "select to_regprocedure('extensions.digest(bytea,text)') is not null;",
  ).stdout, 't');
  assert.equal(sql(
    "select to_regprocedure('pg_catalog.sha256(bytea)') is not null;",
  ).stdout, 't');
  assert.equal(sql(`
    select count(*)
    from (
      values
        ('public.authorize_interview_replacement_core(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean,uuid)'),
        ('public.finalize_interview_final_transcript_reconciliation(uuid,text,uuid,bigint,text,text,text,text,jsonb,jsonb,text)')
    ) as expected(signature)
    where pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(expected.signature)::oid
    ) like '%pg_catalog.sha256(%'
      and pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure(expected.signature)::oid
      ) not like '%public.digest(%';`).stdout, '2');
  assert.equal(sql("select to_regclass('private.interview_final_transcript_reconciliation_claims') is not null;").stdout, 't');
  assert.equal(sql(
    "select to_regprocedure('private.is_valid_interview_transcript_scores(jsonb)') is not null;",
  ).stdout, 't');
  assert.equal(sql(`
    with expected(
      column_name,
      type_oid,
      not_null,
      default_expression,
      dimensions
    ) as (
      values
        ('conversation_id', 'text'::regtype::oid, false, null::text, 0),
        ('transcript_scores', 'jsonb'::regtype::oid, true, '''{}''::jsonb', 0),
        ('interview_summary', 'text'::regtype::oid, false, null::text, 0),
        ('unanswered_candidate_questions', 'text[]'::regtype::oid, true, '''{}''::text[]', 1),
        ('interview_analysis_v2', 'jsonb'::regtype::oid, false, null::text, 0)
    )
    select count(*)
    from expected
    join pg_catalog.pg_attribute as attribute
      on attribute.attrelid='public.interviews'::regclass
      and attribute.attname=expected.column_name
      and attribute.attnum>0
      and not attribute.attisdropped
    left join pg_catalog.pg_attrdef as default_definition
      on default_definition.adrelid=attribute.attrelid
      and default_definition.adnum=attribute.attnum
    where attribute.atttypid=expected.type_oid
      and attribute.attnotnull=expected.not_null
      and pg_catalog.pg_get_expr(
        default_definition.adbin,
        default_definition.adrelid
      ) is not distinct from expected.default_expression
      and attribute.attndims=expected.dimensions
      and attribute.attgenerated=''
      and attribute.attidentity='';`).stdout, '5');
  assert.equal(sql(`select count(*) from public.interviews
    where conversation_id is not null
      or transcript_scores <> '{}'::jsonb
      or interview_summary is not null
      or unanswered_candidate_questions <> '{}'::text[]
      or interview_analysis_v2 is not null;`).stdout, '0');
});

test('serialization DB 1b. actual QA legacy interview columns and populated values are preserved as a no-op', { skip: !ENABLED }, () => {
  assert.match(COMPATIBLE_DATABASE, /^alphascreen_fts_contract_compatible_[0-9]+$/);
  assert.equal(sql(
    `select count(*) from pg_database where datname='${COMPATIBLE_DATABASE}';`,
    { database: 'postgres' },
  ).stdout, '0');
  const created = databaseCommand('createdb', COMPATIBLE_DATABASE);
  assert.equal(created.status, 0, created.stderr);
  runWithPreservedCleanupFailure(() => {
    applyFile(COMPATIBLE_DATABASE, BOOTSTRAP);
    applyFile(COMPATIBLE_DATABASE, PHASE_B);
    applyFile(COMPATIBLE_DATABASE, CORE);
    sql(`alter table public.interviews
      add column transcript_scores jsonb not null default '{}'::jsonb,
      add column interview_summary text null,
      add column unanswered_candidate_questions text[] not null default '{}'::text[],
      add column interview_analysis_v2 jsonb null;`, {
      database: COMPATIBLE_DATABASE,
    });
    const emptyId = '77000000-0000-4000-8000-000000000071';
    const populatedId = '77000000-0000-4000-8000-000000000072';
    sql(`
      insert into public.interviews(id,status,updated_at)
        values ('${emptyId}','Incomplete','2026-07-01T00:00:00Z');
      insert into public.interviews(
        id,status,transcript_scores,interview_summary,
        unanswered_candidate_questions,interview_analysis_v2,updated_at
      ) values (
        '${populatedId}',
        'Completed',
        '{"overall":81,"sentinel":"legacy"}'::jsonb,
        'Synthetic legacy summary.',
        array['Synthetic legacy question?']::text[],
        '{"version":"legacy","sentinel":true}'::jsonb,
        '2026-07-02T00:00:00Z'
      );
    `, { database: COMPATIBLE_DATABASE });
    const beforeValues = sql(`
      select pg_catalog.md5(pg_catalog.string_agg(
        id::text || '|' ||
        transcript_scores::text || '|' ||
        coalesce(interview_summary,'') || '|' ||
        unanswered_candidate_questions::text || '|' ||
        coalesce(interview_analysis_v2::text,'') || '|' ||
        updated_at::text,
        E'\\n' order by id
      ))
      from public.interviews
      where id in ('${emptyId}','${populatedId}');`, {
      database: COMPATIBLE_DATABASE,
    }).stdout;
    applyFile(COMPATIBLE_DATABASE, SERIALIZATION);
    applyFile(COMPATIBLE_DATABASE, SERIALIZATION);
    applyFile(COMPATIBLE_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
    applyFile(COMPATIBLE_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
    const afterValues = sql(`
      select pg_catalog.md5(pg_catalog.string_agg(
        id::text || '|' ||
        transcript_scores::text || '|' ||
        coalesce(interview_summary,'') || '|' ||
        unanswered_candidate_questions::text || '|' ||
        coalesce(interview_analysis_v2::text,'') || '|' ||
        updated_at::text,
        E'\\n' order by id
      ))
      from public.interviews
      where id in ('${emptyId}','${populatedId}');`, {
      database: COMPATIBLE_DATABASE,
    }).stdout;
    assert.equal(afterValues, beforeValues);
    assert.equal(sql(`
      select
        pg_catalog.format_type(scores.atttypid,scores.atttypmod) || '|' ||
        scores.attnotnull::text || '|' ||
        pg_catalog.pg_get_expr(scores_default.adbin,scores_default.adrelid) || '|' ||
        pg_catalog.format_type(questions.atttypid,questions.atttypmod) || '|' ||
        questions.attnotnull::text || '|' ||
        questions.attndims::text || '|' ||
        pg_catalog.pg_get_expr(questions_default.adbin,questions_default.adrelid)
      from pg_catalog.pg_attribute scores
      join pg_catalog.pg_attribute questions
        on questions.attrelid=scores.attrelid
        and questions.attname='unanswered_candidate_questions'
      join pg_catalog.pg_attrdef scores_default
        on scores_default.adrelid=scores.attrelid
        and scores_default.adnum=scores.attnum
      join pg_catalog.pg_attrdef questions_default
        on questions_default.adrelid=questions.attrelid
        and questions_default.adnum=questions.attnum
      where scores.attrelid='public.interviews'::regclass
        and scores.attname='transcript_scores';`, {
      database: COMPATIBLE_DATABASE,
    }).stdout, "jsonb|true|'{}'::jsonb|text[]|true|1|'{}'::text[]");
    assert.equal(sql(`
      select pg_catalog.format_type(atttypid,atttypmod) || '|' ||
        attnotnull::text || '|' || atthasdef::text
      from pg_catalog.pg_attribute
      where attrelid='public.interviews'::regclass
        and attname='conversation_id'
        and attnum>0
        and not attisdropped;`, {
      database: COMPATIBLE_DATABASE,
    }).stdout, 'text|false|false');
    assert.equal(sql(`
      insert into public.interviews(id,status)
        values ('77000000-0000-4000-8000-000000000073','Incomplete')
        returning transcript_scores::text || '|' ||
          unanswered_candidate_questions::text;`, {
      database: COMPATIBLE_DATABASE,
    }).stdout, '{}|{}');
    assert.equal(sql(`
      update public.interviews
      set transcript_scores='{"overall":65}'::jsonb,
          unanswered_candidate_questions=array['Synthetic old-backend question?']::text[],
          interview_summary='Synthetic old-backend summary.',
          interview_analysis_v2='{"version":"legacy"}'::jsonb,
          conversation_id='synthetic-old-backend-conversation'
      where id='77000000-0000-4000-8000-000000000073';
      select transcript_scores->>'overall' || '|' ||
        unanswered_candidate_questions[1] || '|' ||
        interview_summary || '|' ||
        (interview_analysis_v2->>'version') || '|' ||
        conversation_id
      from public.interviews
      where id='77000000-0000-4000-8000-000000000073';`, {
      database: COMPATIBLE_DATABASE,
    }).stdout, '65|Synthetic old-backend question?|Synthetic old-backend summary.|legacy|synthetic-old-backend-conversation');
  }, () => cleanupDisposableDatabase(COMPATIBLE_DATABASE));
});

test('serialization DB 1c. every incompatible pre-existing interview column contract fails clearly', { skip: !ENABLED }, () => {
  const definitions = new Map([
    ['conversation_type', { columnSql: 'conversation_id integer null' }],
    ['conversation_nullability', { columnSql: 'conversation_id text not null' }],
    ['conversation_default', { columnSql: "conversation_id text null default 'synthetic'" }],
    ['conversation_generated', { columnSql: "conversation_id text generated always as ('synthetic'::text) stored" }],
    ['conversation_identity', { columnSql: 'conversation_id bigint generated always as identity' }],
    ['scores_type', { columnSql: "transcript_scores text not null default ''" }],
    ['scores_json', { columnSql: "transcript_scores json not null default '{}'::json" }],
    ['scores_nullability', { columnSql: "transcript_scores jsonb null default '{}'::jsonb" }],
    ['scores_default', { columnSql: "transcript_scores jsonb not null default '[]'::jsonb" }],
    ['scores_generated', { columnSql: "transcript_scores jsonb generated always as ('{}'::jsonb) stored" }],
    ['scores_identity', { columnSql: 'transcript_scores bigint generated always as identity' }],
    ['scores_domain', {
      prelude: 'create domain public.synthetic_scores_domain as jsonb;',
      columnSql: "transcript_scores public.synthetic_scores_domain not null default '{}'::jsonb",
    }],
    ['questions_type', { columnSql: "unanswered_candidate_questions jsonb not null default '{}'::jsonb" }],
    ['questions_scalar_text', { columnSql: "unanswered_candidate_questions text not null default ''" }],
    ['questions_nullability', { columnSql: "unanswered_candidate_questions text[] null default '{}'::text[]" }],
    ['questions_default', { columnSql: "unanswered_candidate_questions text[] not null default array['synthetic']::text[]" }],
    ['questions_generated', { columnSql: "unanswered_candidate_questions text[] generated always as (array['synthetic']::text[]) stored" }],
    ['questions_identity', { columnSql: 'unanswered_candidate_questions bigint generated always as identity' }],
    ['questions_domain', {
      prelude: 'create domain public.synthetic_questions_domain as text[];',
      columnSql: "unanswered_candidate_questions public.synthetic_questions_domain not null default '{}'::text[]",
    }],
    ['questions_multidimensional', { columnSql: "unanswered_candidate_questions text[][] not null default '{}'::text[]" }],
    ['questions_element_type', { columnSql: "unanswered_candidate_questions varchar[] not null default '{}'::varchar[]" }],
    ['summary_type', { columnSql: 'interview_summary integer null' }],
    ['summary_nullability', { columnSql: "interview_summary text not null default ''" }],
    ['summary_default', { columnSql: "interview_summary text null default 'synthetic'" }],
    ['summary_generated', { columnSql: "interview_summary text generated always as ('synthetic'::text) stored" }],
    ['summary_identity', { columnSql: 'interview_summary bigint generated always as identity' }],
    ['analysis_type', { columnSql: 'interview_analysis_v2 text null' }],
    ['analysis_nullability', { columnSql: "interview_analysis_v2 jsonb not null default '{}'::jsonb" }],
    ['analysis_default', { columnSql: "interview_analysis_v2 jsonb null default '{}'::jsonb" }],
    ['analysis_generated', { columnSql: "interview_analysis_v2 jsonb generated always as ('{}'::jsonb) stored" }],
    ['analysis_identity', { columnSql: 'interview_analysis_v2 bigint generated always as identity' }],
  ]);

  for (const [contract, contractDatabase] of INCOMPATIBLE_DATABASES) {
    assert.match(contractDatabase, /^alphascreen_fts_contract_[a-z_]+_[0-9]+$/);
    assert.equal(sql(
      `select count(*) from pg_database where datname='${contractDatabase}';`,
      { database: 'postgres' },
    ).stdout, '0');
    const created = databaseCommand('createdb', contractDatabase);
    assert.equal(created.status, 0, created.stderr);
    runWithPreservedCleanupFailure(() => {
      applyFile(contractDatabase, BOOTSTRAP);
      applyFile(contractDatabase, PHASE_B);
      applyFile(contractDatabase, CORE);
      const definition = definitions.get(contract);
      assert.ok(definition, contract);
      if (definition.prelude) {
        sql(definition.prelude, { database: contractDatabase });
      }
      sql(`alter table public.interviews add column ${definition.columnSql};`, {
        database: contractDatabase,
      });
      const rejected = applyFile(contractDatabase, SERIALIZATION, { allowFailure: true });
      assert.notEqual(rejected.status, 0);
      assert.match(
        `${rejected.stderr || ''}\n${rejected.stdout || ''}`,
        new RegExp(
          `final_transcript_interview_column_contract_mismatch[\\s\\S]*column=${
            contract.startsWith('questions_')
              ? 'unanswered_candidate_questions'
              : contract.startsWith('scores_')
                ? 'transcript_scores'
              : contract.startsWith('summary_')
                ? 'interview_summary'
              : contract.startsWith('analysis_')
                ? 'interview_analysis_v2'
              : 'conversation_id'
          }`,
          'i',
        ),
      );
    }, () => cleanupDisposableDatabase(contractDatabase));
  }
});

test('serialization DB 1d. incompatible ownership-table collisions fail during migration', { skip: !ENABLED }, async (t) => {
  for (const [contract, contractDatabase] of OWNERSHIP_INCOMPATIBLE_DATABASES) {
    await t.test(contract, () => {
      withDisposableDatabase(contractDatabase, () => {
        prepareOwnershipMismatch(contractDatabase, contract);
        const stateBefore = ownershipObjectCatalogState(contractDatabase);
        const rejected = applyFileTransactional(contractDatabase, SERIALIZATION, {
          allowFailure: true,
        });
        assert.notEqual(rejected.status, 0, contract);
        assert.match(
          `${rejected.stderr || ''}\n${rejected.stdout || ''}`,
          /final_transcript_ownership_table_contract_mismatch/i,
          contract,
        );
        assert.equal(
          ownershipObjectCatalogState(contractDatabase),
          stateBefore,
          `transactional rollback: ${contract}`,
        );
        assert.equal(sql(`select count(*)
          from pg_catalog.pg_attribute
          where attrelid='public.interviews'::regclass
            and attname='conversation_id'
            and attnum>0
            and not attisdropped;`, {
          database: contractDatabase,
        }).stdout, '0', `no earlier migration mutation: ${contract}`);
        assert.equal(sql(`select to_regprocedure(
          'private.validate_interview_final_transcript_ownership_contract(boolean)'
        ) is null;`, {
          database: contractDatabase,
        }).stdout, 't', `migration-only helper rolled back: ${contract}`);
      });
    });
  }
});

test('serialization DB 1e. safe RLS and table-ACL drift is corrected and then verified', { skip: !ENABLED }, async (t) => {
  for (const [contract, contractDatabase] of OWNERSHIP_SECURITY_DATABASES) {
    await t.test(contract, () => {
      withDisposableDatabase(contractDatabase, () => {
        prepareOwnershipBaseline(contractDatabase);
        createExactOwnershipTable(contractDatabase);
        if (contract === 'force_rls_disabled') {
          sql(`alter table ${OWNERSHIP_TABLE_QUALIFIED} enable row level security;`, {
            database: contractDatabase,
          });
        } else if (contract === 'service_role_grant') {
          sql(`grant select,update on ${OWNERSHIP_TABLE_QUALIFIED} to service_role;`, {
            database: contractDatabase,
          });
        } else if (contract === 'public_grant') {
          sql(`grant select on ${OWNERSHIP_TABLE_QUALIFIED} to public;`, {
            database: contractDatabase,
          });
        }

        applyFileTransactional(contractDatabase, SERIALIZATION);
        assert.equal(sql(`select relrowsecurity::text||'|'||relforcerowsecurity::text
          from pg_catalog.pg_class
          where oid='${OWNERSHIP_TABLE_QUALIFIED}'::regclass;`, {
          database: contractDatabase,
        }).stdout, 'true|true');
        assert.equal(sql(`select count(*) from pg_catalog.pg_policy
          where polrelid='${OWNERSHIP_TABLE_QUALIFIED}'::regclass;`, {
          database: contractDatabase,
        }).stdout, '0');
        for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
          assert.equal(sql(`select has_table_privilege(
            '${role}',
            '${OWNERSHIP_TABLE_QUALIFIED}',
            'select,insert,update,delete,truncate,references,trigger'
          );`, {
            database: contractDatabase,
          }).stdout, 'f', `${contract}: ${role}`);
        }
      });
    });
  }
});

test('serialization DB 1f. exact populated ownership table is preserved and RPC-compatible', { skip: !ENABLED }, () => {
  withDisposableDatabase(OWNERSHIP_COMPATIBLE_DATABASE, () => {
    prepareOwnershipBaseline(OWNERSHIP_COMPATIBLE_DATABASE);
    createExactOwnershipTable(OWNERSHIP_COMPATIBLE_DATABASE);
    sql(`alter table ${OWNERSHIP_TABLE_QUALIFIED} enable row level security;
      alter table ${OWNERSHIP_TABLE_QUALIFIED} force row level security;
      revoke all on table ${OWNERSHIP_TABLE_QUALIFIED}
        from public,anon,authenticated,service_role;`, {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    });

    const preserved = fixture(40);
    const runtime = fixture(39);
    sql(`
      insert into public.clients(id,name,email,archived_at,access_override_mode)
        values ('${ID.client}','Ownership contract','ownership@example.test',null,'inherit');
      insert into public.roles(id,client_id,title,slug_or_token,status)
        values ('${ID.role}','${ID.client}','Ownership role','ownership-role','active');
      insert into public.candidates(id,client_id,role_id,name,email,status,interview_status)
        values
          ('${preserved.candidateId}','${ID.client}','${ID.role}',
            'Ownership fixture preserved','ownership-preserved@example.test','Verified','Incomplete'),
          ('${runtime.candidateId}','${ID.client}','${ID.role}',
            'Ownership fixture runtime','ownership-runtime@example.test','Verified','Incomplete');
      insert into public.interviews(
        id,candidate_id,client_id,role_id,status,attempt_number,is_active,
        tavus_application_id,failure_code,failure_stage,failure_summary,retryable,
        replacement_eligible,has_substantive_response,substantive_response_count,
        candidate_utterance_count,utterance_classification_counts,
        conversation_progress_state
      ) values
        (
          '${preserved.interviewId}','${preserved.candidateId}','${ID.client}','${ID.role}',
          'Incomplete',1,false,'${preserved.conversationId}','INTERVIEW_PROGRESS_STALLED',
          'live_interview','Synthetic ownership evidence',true,true,false,0,0,'{}',
          'WaitingForAnswer'
        ),
        (
          '${runtime.interviewId}','${runtime.candidateId}','${ID.client}','${ID.role}',
          'Incomplete',1,false,'${runtime.conversationId}','INTERVIEW_PROGRESS_STALLED',
          'live_interview','Synthetic runtime evidence',true,true,false,0,0,'{}',
          'WaitingForAnswer'
        );
      insert into ${OWNERSHIP_TABLE_QUALIFIED}(
        interview_id,processing_state,claim_version,completed_at,
        authoritative_transcript_hash,authoritative_transcript_storage_ref,
        authoritative_evidence_snapshot,authoritative_provider_event_key,
        analysis_processing_state,analysis_last_completed_claim_token,
        analysis_claim_version,analysis_completed_at,
        analysis_completed_transcript_claim_version,analysis_completed_transcript_hash,
        created_at,updated_at
      ) values (
        '${preserved.interviewId}','completed',7,'2026-07-24T00:00:00Z',
        '${'a'.repeat(64)}','synthetic/ownership/reference',
        ${json(STRONG)},'${'b'.repeat(64)}',
        'completed','77000000-0000-4000-8000-000000000888',
        4,'2026-07-24T00:00:01Z',7,'${'a'.repeat(64)}',
        '2026-07-24T00:00:00Z','2026-07-24T00:00:02Z'
      );
    `, { database: OWNERSHIP_COMPATIBLE_DATABASE });
    const rowBefore = sql(`select row_to_json(c)::text
      from ${OWNERSHIP_TABLE_QUALIFIED} c
      where interview_id='${preserved.interviewId}';`, {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout;

    applyFileTransactional(OWNERSHIP_COMPATIBLE_DATABASE, SERIALIZATION);
    applyFileTransactional(OWNERSHIP_COMPATIBLE_DATABASE, SERIALIZATION);
    applyFileTransactional(OWNERSHIP_COMPATIBLE_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
    applyFileTransactional(OWNERSHIP_COMPATIBLE_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
    assert.equal(sql(`select row_to_json(c)::text
      from ${OWNERSHIP_TABLE_QUALIFIED} c
      where interview_id='${preserved.interviewId}';`, {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout, rowBefore);

    const transcriptClaim = parseClaim(sql(claimSql(runtime), {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout);
    assert.equal(transcriptClaim.outcome, 'claimed');
    assert.equal(sql(finalizeSql(runtime, transcriptClaim), {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout.split('|')[0], 'finalized');
    assert.equal(sql(persistQuestionsSql(
      runtime,
      transcriptClaim.version,
      runtime.hash,
      ['Synthetic bounded question?'],
    ), {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout, 'stored');
    const analysisClaim = parseAnalysisV2Claim(sql(claimAnalysisV2Sql(
      runtime,
      transcriptClaim.version,
      runtime.hash,
    ), {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout);
    assert.equal(analysisClaim.outcome, 'claimed');
    assert.equal(sql(finalizeAnalysisV2Sql(
      runtime,
      analysisClaim,
      transcriptClaim.version,
      runtime.hash,
      analysisV2(1),
    ), {
      database: OWNERSHIP_COMPATIBLE_DATABASE,
    }).stdout, 'stored');
  });
});

test('serialization DB 1g. schema, search-path, temporary, and quoted lookalikes cannot redirect creation', { skip: !ENABLED }, () => {
  withDisposableDatabase(OWNERSHIP_EDGE_DATABASE, () => {
    prepareOwnershipBaseline(OWNERSHIP_EDGE_DATABASE);
    sql(`create schema shadow;
      create table shadow.${OWNERSHIP_TABLE_NAME}(interview_id integer);
      create table private."Interview_Final_Transcript_Reconciliation_Claims"(
        interview_id integer
      );`, {
      database: OWNERSHIP_EDGE_DATABASE,
    });
    const child = spawnSync(
      'psql',
      psqlArgs(OWNERSHIP_EDGE_DATABASE),
      {
        encoding: 'utf8',
        input: `begin;
          create temporary table ${OWNERSHIP_TABLE_NAME}(interview_id integer);
          set local search_path=pg_temp,shadow,public;
          \\i ${SERIALIZATION}
          commit;
          select to_regclass('private.${OWNERSHIP_TABLE_NAME}') is not null;
          \\q
        `,
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /t/);
    assert.equal(sql(`select
      (select count(*) from pg_catalog.pg_attribute
        where attrelid='private.${OWNERSHIP_TABLE_NAME}'::regclass
          and attnum>0 and not attisdropped)||'|'||
      (select count(*) from pg_catalog.pg_attribute
        where attrelid='shadow.${OWNERSHIP_TABLE_NAME}'::regclass
          and attnum>0 and not attisdropped)||'|'||
      (select count(*) from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='private'
          and c.relname='Interview_Final_Transcript_Reconciliation_Claims');
    `, {
      database: OWNERSHIP_EDGE_DATABASE,
    }).stdout, '32|1|1');
  });
});

test('serialization DB 2. private table and RPC privileges are least privilege', { skip: !ENABLED }, () => {
  for (const role of ['public', 'anon', 'authenticated']) {
    if (role !== 'public') {
      const direct = sql(`set role ${role}; select * from private.interview_final_transcript_reconciliation_claims;`, { allowFailure: true });
      assert.notEqual(direct.status, 0);
      assert.match(direct.stderr, /permission denied/i);
    }
  }
  assert.equal(sql("select has_table_privilege('service_role','private.interview_final_transcript_reconciliation_claims','select');").stdout, 'f');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(sql(`select has_function_privilege('${role}',
      'public.claim_interview_final_transcript_reconciliation(uuid,text,text,text,jsonb,integer)','execute');`).stdout, 'f');
  }
  assert.equal(sql("select has_function_privilege('service_role','public.claim_interview_final_transcript_reconciliation(uuid,text,text,text,jsonb,integer)','execute');").stdout, 't');
  assert.equal(sql(`select count(*)
    from pg_catalog.pg_proc p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid='public.persist_interview_unanswered_questions_if_authoritative(uuid,bigint,text,jsonb)'::regprocedure
      and acl.grantee=0
      and acl.privilege_type='EXECUTE';`).stdout, '0');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(sql(`select has_function_privilege('${role}',
      'public.persist_interview_unanswered_questions_if_authoritative(uuid,bigint,text,jsonb)',
      'execute');`).stdout, 'f');
  }
  assert.equal(sql(`select has_function_privilege(
    'service_role',
    'public.persist_interview_unanswered_questions_if_authoritative(uuid,bigint,text,jsonb)',
    'execute'
  );`).stdout, 't');
  assert.equal(sql(`select prosecdef
      and coalesce(array_to_string(proconfig, ','), '') like '%search_path=""%'
    from pg_catalog.pg_proc
    where oid='public.persist_interview_unanswered_questions_if_authoritative(uuid,bigint,text,jsonb)'::regprocedure;`).stdout, 't');
  for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
    assert.equal(sql(`select has_function_privilege(
      '${role}',
      'private.is_valid_interview_transcript_scores(jsonb)',
      'execute'
    );`).stdout, 'f');
  }
  assert.equal(sql(`select not prosecdef
      and coalesce(array_to_string(proconfig, ','), '') like '%search_path=""%'
    from pg_catalog.pg_proc
    where oid='private.is_valid_interview_transcript_scores(jsonb)'::regprocedure;`).stdout, 't');
});

test('serialization DB 2b. application and PostgreSQL score validators agree on shared vectors', { skip: !ENABLED }, () => {
  for (const vector of transcriptScoreContractVectors()) {
    const applicationDecision = validateTranscriptScores(vector.value).valid;
    const databaseDecision = sql(
      `select private.is_valid_interview_transcript_scores(${json(vector.value)});`,
    ).stdout === 't';
    assert.equal(applicationDecision, vector.valid, `application decision: ${vector.name}`);
    assert.equal(databaseDecision, vector.valid, `database decision: ${vector.name}`);
    assert.equal(databaseDecision, applicationDecision, `validator parity: ${vector.name}`);
  }
});

test('serialization DB 2c. service-role malformed scores fail before canonical state changes', { skip: !ENABLED }, () => {
  const item = fixture(35);
  sql(`update public.interviews
    set transcript='Historical synthetic transcript.',
        transcript_url='historical/synthetic/reference.txt',
        transcript_scores=${json(VALID_TRANSCRIPT_SCORES)},
        interview_summary='Historical synthetic summary.'
    where id='${item.interviewId}';`);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.outcome, 'claimed');
  const interviewBefore = sql(`select row_to_json(state)::text
    from (
      select transcript,transcript_url,transcript_scores,interview_summary,
        has_substantive_response,substantive_response_count,candidate_utterance_count,
        utterance_classification_counts,conversation_progress_state,status,
        unanswered_candidate_questions,interview_analysis_v2,updated_at
      from public.interviews where id='${item.interviewId}'
    ) state;`).stdout;
  const claimBefore = sql(`select row_to_json(state)::text
    from (
      select processing_state,claim_token,claim_version,lease_expires_at,claimed_at,
        pending_transcript_hash,pending_evidence_snapshot,pending_provider_event_key,
        scoring_required,completed_at,authoritative_transcript_hash,
        authoritative_transcript_storage_ref,authoritative_evidence_snapshot,
        authoritative_provider_event_key,last_failure_category
      from private.interview_final_transcript_reconciliation_claims
      where interview_id='${item.interviewId}'
    ) state;`).stdout;
  const relatedBefore = sql(`select
    (select count(*) from public.reports)||'|'||
    (select count(*) from public.interview_reset_events)||'|'||
    (select count(*) from public.interview_adjudications)||'|'||
    (select count(*) from public.interview_admin_audit_logs)||'|'||
    (select count(*) from private.interview_vendor_binding_recovery);`).stdout;

  for (const vector of transcriptScoreContractVectors().filter((candidate) => !candidate.valid)) {
    const rejected = sql(finalizeSql(item, claim, { scores: vector.value }), { allowFailure: true });
    assert.notEqual(rejected.status, 0, `service-role rejection: ${vector.name}`);
    assert.match(rejected.stderr, /invalid_transcript_scores/i, `bounded error: ${vector.name}`);
    assert.equal(sql(`select row_to_json(state)::text
      from (
        select transcript,transcript_url,transcript_scores,interview_summary,
          has_substantive_response,substantive_response_count,candidate_utterance_count,
          utterance_classification_counts,conversation_progress_state,status,
          unanswered_candidate_questions,interview_analysis_v2,updated_at
        from public.interviews where id='${item.interviewId}'
      ) state;`).stdout, interviewBefore, `interview rollback: ${vector.name}`);
    assert.equal(sql(`select row_to_json(state)::text
      from (
        select processing_state,claim_token,claim_version,lease_expires_at,claimed_at,
          pending_transcript_hash,pending_evidence_snapshot,pending_provider_event_key,
          scoring_required,completed_at,authoritative_transcript_hash,
          authoritative_transcript_storage_ref,authoritative_evidence_snapshot,
          authoritative_provider_event_key,last_failure_category
        from private.interview_final_transcript_reconciliation_claims
        where interview_id='${item.interviewId}'
      ) state;`).stdout, claimBefore, `claim rollback: ${vector.name}`);
  }
  assert.equal(sql(`select
    (select count(*) from public.reports)||'|'||
    (select count(*) from public.interview_reset_events)||'|'||
    (select count(*) from public.interview_adjudications)||'|'||
    (select count(*) from public.interview_admin_audit_logs)||'|'||
    (select count(*) from private.interview_vendor_binding_recovery);`).stdout, relatedBefore);
  assert.equal(sql(finalizeSql(item, claim, { scores: VALID_TRANSCRIPT_SCORES })).stdout.split('|')[0], 'finalized');
});

test('serialization DB 2d. score boundary and enum objects finalize through the service-role RPC', { skip: !ENABLED }, () => {
  const validVectors = transcriptScoreContractVectors().filter((vector) => vector.valid);
  const selected = [
    validVectors.find((vector) => vector.name === 'valid minimum'),
    validVectors.find((vector) => vector.name === 'valid maximum'),
    validVectors.find((vector) => vector.name === 'valid medium enum'),
    validVectors.find((vector) => vector.name === 'valid high enum'),
  ];
  for (let index = 0; index < selected.length; index += 1) {
    const item = fixture(36 + index);
    const claim = parseClaim(sql(claimSql(item)).stdout);
    assert.equal(claim.outcome, 'claimed');
    assert.equal(
      sql(finalizeSql(item, claim, { scores: selected[index].value })).stdout.split('|')[0],
      'finalized',
      selected[index].name,
    );
  }
});

test('serialization DB 2e. legacy empty score defaults require scoring and change only on valid finalization', { skip: !ENABLED }, () => {
  const item = fixture(41);
  assert.equal(sql(`select transcript_scores='{}'::jsonb
      and unanswered_candidate_questions='{}'::text[]
      and transcript_scores is not null
    from public.interviews
    where id='${item.interviewId}';`).stdout, 't');

  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.outcome, 'claimed');
  assert.equal(claim.scoringRequired, true);

  const rejected = sql(finalizeSql(item, claim, { scores: {} }), {
    allowFailure: true,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /invalid_transcript_scores/i);
  assert.equal(sql(`select transcript_scores='{}'::jsonb
      and unanswered_candidate_questions='{}'::text[]
    from public.interviews
    where id='${item.interviewId}';`).stdout, 't');

  assert.equal(
    sql(finalizeSql(item, claim, { scores: VALID_TRANSCRIPT_SCORES })).stdout.split('|')[0],
    'finalized',
  );
  assert.equal(sql(`select transcript_scores=${json(VALID_TRANSCRIPT_SCORES)}
      and transcript_scores is not null
      and unanswered_candidate_questions='{}'::text[]
    from public.interviews
    where id='${item.interviewId}';`).stdout, 't');
});

test('serialization DB 3. twenty barrier-released first claims yield one owner and nineteen busy results', { skip: !ENABLED }, async () => {
  const item = fixture(1);
  const results = await concurrentSql(Array.from({ length: 20 }, () => claimSql(item)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const claims = results.map((result) => parseClaim(result.stdout));
  assert.equal(claims.filter((claim) => claim.outcome === 'claimed').length, 1);
  assert.equal(claims.filter((claim) => claim.outcome === 'busy').length, 19);
  const winner = claims.find((claim) => claim.outcome === 'claimed');
  assert.equal(sql(`select processing_state||'|'||claim_version
    from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}';`).stdout, 'claimed|1');
  assert.equal(sql(releaseSql(item, winner)).stdout, 'released');
  assert.equal(sql(releaseSql(item, winner)).stdout, 'already_released');
});

test('serialization DB 4. duplicate claims serialize, unexpired leases cannot be stolen, and an expired lease is reclaimed once', { skip: !ENABLED }, async () => {
  const item = fixture(2);
  const first = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(first.outcome, 'claimed');
  assert.equal(parseClaim(sql(claimSql(item)).stdout).outcome, 'busy');
  sql(`update private.interview_final_transcript_reconciliation_claims
    set claimed_at=now()-interval '2 seconds',
        lease_expires_at=now()-interval '1 second'
    where interview_id='${item.interviewId}';`);
  const results = await concurrentSql([claimSql(item), claimSql(item)]);
  const claims = results.map((result) => parseClaim(result.stdout));
  assert.equal(claims.filter((claim) => claim.outcome === 'recovered_expired_claim').length, 1);
  assert.equal(claims.filter((claim) => claim.outcome === 'busy').length, 1);
  const winner = claims.find((claim) => claim.outcome === 'recovered_expired_claim');
  assert.equal(winner.version, 2);
  assert.equal(sql(releaseSql(item, winner, 'worker_shutdown')).stdout, 'released');
});

test('serialization DB 5. malformed and unknown-key snapshots fail closed before ownership', { skip: !ENABLED }, () => {
  const item = fixture(3);
  for (const snapshot of [
    { ...STRONG, arbitrary: true },
    { ...STRONG, classification_counts: { ...ALLOWED_COUNTS, arbitrary: 1 }, candidate_utterance_count: 2 },
    { ...STRONG, candidate_utterance_count: 2 },
    { ...STRONG, substantive_response_count: 2 },
    { ...STRONG, has_substantive_response: false },
    { ...STRONG, candidate_word_count: 1.5 },
  ]) {
    assert.equal(parseClaim(sql(claimSql(item, { snapshot })).stdout).outcome, 'invalid_snapshot');
  }
  assert.equal(sql(`select count(*) from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}' and processing_state='claimed';`).stdout, '0');
});

test('serialization DB 6. wrong token and version cannot finalize or release another worker claim', { skip: !ENABLED }, () => {
  const item = fixture(4);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  const wrongToken = { ...claim, token: '77000000-0000-4000-8000-000000000099' };
  const wrongVersion = { ...claim, version: claim.version + 1 };
  for (const invalid of [wrongToken, wrongVersion]) {
    const finalized = sql(finalizeSql(item, invalid), { allowFailure: true });
    assert.notEqual(finalized.status, 0);
    assert.match(finalized.stderr, /final_transcript_claim_mismatch/i);
    assert.equal(sql(releaseSql(item, invalid)).stdout, 'claim_mismatch');
  }
  assert.equal(sql(releaseSql(item, claim)).stdout, 'released');
});

test('serialization DB 7. valid finalization completes once and identical delivery is a no-op', { skip: !ENABLED }, () => {
  const item = fixture(5);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.scoringRequired, true);
  const finalized = sql(finalizeSql(item, claim)).stdout.split('|');
  assert.equal(finalized[0], 'finalized');
  assert.equal(finalized[1], 'incoming');
  assert.equal(sql(`select has_substantive_response||'|'||substantive_response_count||'|'||
    candidate_utterance_count||'|'||conversation_progress_state
    from public.interviews where id='${item.interviewId}';`).stdout, 'true|1|1|CandidateResponded');
  assert.equal(parseClaim(sql(claimSql(item)).stdout).outcome, 'already_reconciled');
});

test('serialization DB 8. concurrent finalizers cannot both mutate', { skip: !ENABLED }, async () => {
  const item = fixture(6);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  const results = await concurrentSql([finalizeSql(item, claim), finalizeSql(item, claim)]);
  assert.equal(results.filter((result) => result.status === 0).length, 2);
  const outcomes = results.map((result) => result.stdout.trim().split(/\r?\n/).at(-1).split('|')[0]);
  assert.equal(outcomes.filter((outcome) => outcome === 'finalized').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === 'already_reconciled').length, 1);
  assert.equal(sql(`select claim_version from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}';`).stdout, '1');
});

test('serialization DB 9. a live writer holding the interview lock is observed before finalization and cannot be lost', { skip: !ENABLED }, async () => {
  const item = fixture(7);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  const lifecycle = spawnPsql();
  lifecycle.write(`begin;
    update public.interviews set
      has_substantive_response=true,
      substantive_response_count=2,
      candidate_utterance_count=2,
      utterance_classification_counts='{"substantive_answer":2}'::jsonb,
      conversation_progress_state='CandidateResponded'
    where id='${item.interviewId}';
    \\echo LIFECYCLE_LOCKED
  `);
  await waitForOutput(lifecycle, 'LIFECYCLE_LOCKED');

  const finalizer = spawnPsql();
  finalizer.end(`${finalizeSql(item, claim)}\n\\q\n`);
  await waitForBlockedQuery('finalize_interview_final_transcript_reconciliation');
  lifecycle.end('commit;\n\\q\n');
  assert.equal((await lifecycle.done).status, 0);
  const finalized = await finalizer.done;
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(finalized.stdout.split('|')[0], 'superseded_by_stronger_evidence');
  assert.equal(sql(`select substantive_response_count||'|'||candidate_utterance_count
    from public.interviews where id='${item.interviewId}';`).stdout, '2|2');
});

test('serialization DB 10. a later lifecycle write strengthens completed canonical evidence without regression', { skip: !ENABLED }, () => {
  const item = fixture(8);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`set role service_role; select public.record_interview_lifecycle_event(
    '${item.interviewId}','${ID.client}','conversation.utterance','lifecycle-8','lifecycle-8',
    'candidate','substantive_answer',now(),'{"word_count":10}'::jsonb);`).stdout, 't');
  assert.equal(sql(`select substantive_response_count||'|'||candidate_utterance_count
    from public.interviews where id='${item.interviewId}';`).stdout, '2|2');
  const sparse = fixture(8, { transcript: 'CANDIDATE: Okay.', snapshot: SPARSE });
  assert.equal(parseClaim(sql(claimSql(sparse)).stdout).outcome, 'superseded_by_stronger_evidence');
  assert.equal(sql(`select substantive_response_count||'|'||candidate_utterance_count
    from public.interviews where id='${item.interviewId}';`).stdout, '2|2');
});

test('serialization DB 11. sparse authoritative evidence can be replaced by stronger evidence, never the reverse', { skip: !ENABLED }, () => {
  const sparse = fixture(9, { transcript: 'CANDIDATE: Okay.', snapshot: SPARSE });
  const sparseClaim = parseClaim(sql(claimSql(sparse)).stdout);
  assert.equal(sql(finalizeSql(sparse, sparseClaim)).stdout.split('|')[0], 'finalized');
  const strong = fixture(9);
  const strongClaim = parseClaim(sql(claimSql(strong)).stdout);
  assert.equal(strongClaim.outcome, 'claimed');
  assert.equal(strongClaim.scoringRequired, true);
  assert.equal(sql(finalizeSql(strong, strongClaim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`select transcript_scores->>'overall'||'|'||interview_summary
    from public.interviews where id='${strong.interviewId}';`).stdout,
  '70|Synthetic scored summary.');
  const before = sql(`select authoritative_transcript_hash||'|'||authoritative_transcript_storage_ref
    from private.interview_final_transcript_reconciliation_claims where interview_id='${strong.interviewId}';`).stdout;
  assert.equal(parseClaim(sql(claimSql(sparse)).stdout).outcome, 'superseded_by_stronger_evidence');
  assert.equal(sql(`select authoritative_transcript_hash||'|'||authoritative_transcript_storage_ref
    from private.interview_final_transcript_reconciliation_claims where interview_id='${strong.interviewId}';`).stdout, before);
});

test('serialization DB 12. coherent snapshots are indivisible and classification totals remain exact', { skip: !ENABLED }, () => {
  const item = fixture(10, { snapshot: STRONGER });
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`select
    candidate_utterance_count=(select coalesce(sum(value::integer),0) from jsonb_each_text(utterance_classification_counts))
    and substantive_response_count=coalesce((utterance_classification_counts->>'substantive_answer')::integer,0)
    and has_substantive_response=(substantive_response_count>0)
    from public.interviews where id='${item.interviewId}';`).stdout, 't');
});

test('serialization DB 12b. SQL legacy-prefix ordering matches the JavaScript contract', { skip: !ENABLED }, () => {
  const legacyCurrent = {
    has_substantive_response: STRONG.has_substantive_response,
    substantive_response_count: STRONG.substantive_response_count,
    candidate_utterance_count: STRONG.candidate_utterance_count,
    classification_counts: STRONG.classification_counts,
    conversation_progress_state: STRONG.conversation_progress_state,
  };
  assert.equal(sql(`select
      private.is_valid_interview_final_transcript_legacy_snapshot(${json(legacyCurrent)})::text||'|'||
      (private.interview_final_transcript_known_prefix_strength(${json(legacyCurrent)}) =
        private.interview_final_transcript_known_prefix_strength(${json(STRONG)}))::text||'|'||
      (private.interview_final_transcript_known_prefix_strength(${json(legacyCurrent)}) <
        private.interview_final_transcript_known_prefix_strength(${json(STRONGER)}))::text||'|'||
      (not private.is_valid_interview_final_transcript_legacy_snapshot(
        ${json({ ...legacyCurrent, candidate_word_count: 0 })}
      ))::text;`).stdout, 'true|true|true|true');
});

test('serialization DB 13. simulated finalize failure rolls back interview and claim completion atomically', { skip: !ENABLED }, () => {
  const item = fixture(11);
  const failingText = `${item.transcript} ROLLBACK_SENTINEL`;
  const failingItem = {
    ...item,
    transcript: failingText,
    hash: hash(failingText),
  };
  const claim = parseClaim(sql(claimSql(failingItem)).stdout);
  sql(`
    create function public.synthetic_final_transcript_failure() returns trigger language plpgsql as $$
    begin
      if new.transcript like '%ROLLBACK_SENTINEL%' then
        raise exception 'synthetic_finalize_failure';
      end if;
      return new;
    end $$;
    create trigger synthetic_final_transcript_failure
      before update on public.interviews for each row execute function public.synthetic_final_transcript_failure();
  `);
  const failed = sql(finalizeSql(failingItem, claim), { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic_finalize_failure/);
  assert.equal(sql(`select transcript is null from public.interviews where id='${item.interviewId}';`).stdout, 't');
  assert.equal(sql(`select processing_state from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}';`).stdout, 'claimed');
  sql('drop trigger synthetic_final_transcript_failure on public.interviews; drop function public.synthetic_final_transcript_failure();');
  assert.equal(sql(releaseSql(failingItem, claim, 'finalize_failed')).stdout, 'released');
  const retry = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(retry.outcome, 'claimed');
  assert.equal(retry.version, 2);
  assert.equal(sql(releaseSql(item, retry)).stdout, 'released');
});

test('serialization DB 14. historical unversioned scoring is replaced transactionally during canonical repair', { skip: !ENABLED }, () => {
  const item = fixture(12);
  const scores = { overall: 82, confidence: 75, sentinel: 'UNCHANGED' };
  sql(`update public.interviews set transcript_scores=${json(scores)},interview_summary='Existing summary'
    where id='${item.interviewId}';`);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.scoringRequired, true);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`select (transcript_scores ? 'sentinel')::text||'|'||interview_summary
    from public.interviews where id='${item.interviewId}';`).stdout,
  'false|Synthetic scored summary.');
  assert.equal(sql(`select has_substantive_response from public.interviews where id='${item.interviewId}';`).stdout, 't');
});

test('serialization DB 14b. equal known legacy strength preserves richer current evidence when word count is unknown', { skip: !ENABLED }, () => {
  const item = fixture(33, {
    transcript: 'CANDIDATE: Yes.',
    snapshot: {
      ...STRONG,
      candidate_word_count: 1,
    },
  });
  sql(`update public.interviews set
      transcript='CANDIDATE: Existing richer canonical response remains selected.',
      transcript_scores=${json({ overall: 88, confidence: 80 })},
      interview_summary='Existing canonical summary',
      has_substantive_response=true,
      substantive_response_count=1,
      candidate_utterance_count=1,
      utterance_classification_counts=${json(ALLOWED_COUNTS)},
      conversation_progress_state='CandidateResponded'
    where id='${item.interviewId}';`);
  const before = sql(`select transcript||'|'||interview_summary
    from public.interviews where id='${item.interviewId}';`).stdout;
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.outcome, 'superseded_by_stronger_evidence');
  assert.equal(sql(`select transcript||'|'||interview_summary
    from public.interviews where id='${item.interviewId}';`).stdout, before);
});

test('serialization DB 14c. strictly stronger known legacy prefix may claim and replaces unversioned scores', { skip: !ENABLED }, () => {
  const item = fixture(34, { snapshot: STRONGER });
  sql(`update public.interviews set
      transcript='CANDIDATE: Existing one-response canonical state.',
      transcript_scores=${json({ overall: 81, confidence: 75, sentinel: 'legacy' })},
      interview_summary='Legacy summary',
      has_substantive_response=true,
      substantive_response_count=1,
      candidate_utterance_count=1,
      utterance_classification_counts=${json(ALLOWED_COUNTS)},
      conversation_progress_state='CandidateResponded'
    where id='${item.interviewId}';`);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(claim.outcome, 'claimed');
  assert.equal(claim.scoringRequired, true);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`select substantive_response_count||'|'||candidate_utterance_count||'|'||
      (transcript_scores ? 'sentinel')::text
    from public.interviews where id='${item.interviewId}';`).stdout, '2|2|false');
});

test('serialization DB 15. completed aliases and watchdog status/termination fields are preserved', { skip: !ENABLED }, () => {
  for (const [index, status] of [[13, 'Completed'], [14, 'Complete'], [15, 'Analyzed']]) {
    const item = fixture(index);
    sql(`update public.interviews set status='${status}',failure_code=null,retryable=false,replacement_eligible=false
      where id='${item.interviewId}';`);
    const claim = parseClaim(sql(claimSql(item)).stdout);
    assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
    assert.equal(sql(`select status from public.interviews where id='${item.interviewId}';`).stdout, status);
  }

  for (const [index, snapshot, transcript] of [
    [16, STRONG, fixture(16).transcript],
    [19, SPARSE, 'CANDIDATE: Okay.'],
  ]) {
    const item = fixture(index, { snapshot, transcript });
    const before = sql(`select status||'|'||failure_code||'|'||failure_stage||'|'||failure_summary
      from public.interviews where id='${item.interviewId}';`).stdout;
    const claim = parseClaim(sql(claimSql(item)).stdout);
    assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
    const afterState = sql(`select status||'|'||failure_code||'|'||failure_stage||'|'||failure_summary
      from public.interviews where id='${item.interviewId}';`).stdout;
    assert.equal(afterState, before);
    assert.equal(sql(`select conversation_progress_state from public.interviews
      where id='${item.interviewId}';`).stdout,
    snapshot.has_substantive_response ? 'CandidateResponded' : 'NoSubstantiveCandidateResponse');
  }
});

test('serialization DB 16. binding mismatch cannot claim or update another interview', { skip: !ENABLED }, () => {
  const item = fixture(17);
  const output = sql(claimSql({ ...item, conversationId: 'wrong-conversation' })).stdout;
  assert.equal(parseClaim(output).outcome, 'binding_not_found');
  assert.equal(sql(`select count(*) from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}' and processing_state='claimed';`).stdout, '0');
});

test('serialization DB 17. attempt, report, authorization, provider binding, and unrelated tables remain unchanged', { skip: !ENABLED }, () => {
  const item = fixture(24);
  const interviewBefore = sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||tavus_application_id
    from public.interviews where id='${item.interviewId}';`).stdout;
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  assert.equal(sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||tavus_application_id
    from public.interviews where id='${item.interviewId}';`).stdout, interviewBefore);
  assert.equal(sql(`select
    (select count(*) from public.interviews)||'|'||
    (select count(*) from public.reports)||'|'||
    (select count(*) from public.interview_reset_events)||'|'||
    (select count(*) from public.interview_adjudications)||'|'||
    (select count(*) from public.interview_admin_audit_logs)||'|'||
    (select count(*) from private.interview_vendor_binding_recovery)||'|'||
    (select count(*) from public.otp_tokens)||'|'||
    (select count(*) from public.email_delivery_events);`).stdout, baselineInventory);
});

test('serialization DB 18. authoritative unanswered questions store once and reject stale tuples', { skip: !ENABLED }, () => {
  const item = fixture(20);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  const claimBefore = sql(`select processing_state||'|'||claim_version||'|'||
    authoritative_transcript_hash||'|'||authoritative_transcript_storage_ref
    from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}';`).stdout;
  const questions = ['Synthetic question one?', 'Synthetic question two?'];
  assert.equal(
    sql(persistQuestionsSql(item, claim.version, item.hash, questions)).stdout,
    'stored',
  );
  assert.equal(
    sql(persistQuestionsSql(item, claim.version, item.hash, questions)).stdout,
    'already_present',
  );
  assert.equal(
    sql(persistQuestionsSql(item, claim.version - 1, item.hash, questions)).stdout,
    'superseded',
  );
  assert.equal(
    sql(persistQuestionsSql(item, claim.version, hash('wrong hash'), questions)).stdout,
    'superseded',
  );
  assert.equal(sql(`select cardinality(unanswered_candidate_questions)
    from public.interviews where id='${item.interviewId}';`).stdout, '2');
  assert.equal(sql(`select processing_state||'|'||claim_version||'|'||
    authoritative_transcript_hash||'|'||authoritative_transcript_storage_ref
    from private.interview_final_transcript_reconciliation_claims
    where interview_id='${item.interviewId}';`).stdout, claimBefore);
});

test('serialization DB 19. incomplete claims, missing interviews, and invalid question payloads fail closed', { skip: !ENABLED }, () => {
  const item = fixture(21);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  const validQuestions = ['Synthetic bounded question?'];
  assert.equal(
    sql(persistQuestionsSql(item, claim.version, item.hash, validQuestions)).stdout,
    'superseded',
  );
  assert.equal(
    sql(`set role service_role;
      select outcome
      from public.persist_interview_unanswered_questions_if_authoritative(
        '77000000-0000-4000-8001-999999999999',
        1,
        '${item.hash}',
        ${json(validQuestions)}
      );`).stdout,
    'interview_not_found',
  );

  const invalidPayloads = [
    null,
    {},
    [],
    Array.from({ length: 11 }, (_, index) => `Synthetic question ${index}?`),
    ['q'.repeat(1_001)],
    Array.from({ length: 10 }, (_, index) => `${index}${'q'.repeat(997)}`),
    ['duplicate?', 'duplicate?'],
    [' whitespace? '],
    [{ text: 'nested object is not allowed' }],
  ];
  for (const payload of invalidPayloads) {
    assert.equal(
      sql(persistQuestionsSql(item, claim.version, item.hash, payload)).stdout,
      'invalid_questions',
    );
  }
  assert.equal(sql(`select unanswered_candidate_questions = '{}'::text[]
    from public.interviews where id='${item.interviewId}';`).stdout, 't');
  assert.equal(sql(releaseSql(item, claim)).stdout, 'released');
});

test('serialization DB 20. concurrent authoritative question writers store exactly once', { skip: !ENABLED }, async () => {
  const item = fixture(22);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  const questions = ['Synthetic concurrent question?'];
  const results = await concurrentSql([
    persistQuestionsSql(item, claim.version, item.hash, questions),
    persistQuestionsSql(item, claim.version, item.hash, questions),
  ]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const outcomes = results.map((result) => result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(outcomes.filter((outcome) => outcome === 'stored').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === 'already_present').length, 1);
  assert.equal(sql(`select cardinality(unanswered_candidate_questions)
    from public.interviews where id='${item.interviewId}';`).stdout, '1');
});

test('serialization DB 21. stronger finalization wins before a queued stale question writer', { skip: !ENABLED }, async () => {
  const weak = fixture(23, {
    transcript: 'CANDIDATE: Okay.',
    snapshot: SPARSE,
  });
  const weakClaim = parseClaim(sql(claimSql(weak)).stdout);
  assert.equal(sql(finalizeSql(weak, weakClaim)).stdout.split('|')[0], 'finalized');

  const strong = fixture(23, {
    transcript: 'CANDIDATE: I completed two synthetic systems with measurable results.',
    snapshot: STRONGER,
  });
  const strongClaim = parseClaim(sql(claimSql(strong)).stdout);
  assert.equal(strongClaim.outcome, 'claimed');
  assert.equal(strongClaim.version, weakClaim.version + 1);

  const lockHolder = spawnPsql();
  lockHolder.write(`begin;
    select interview_id
    from private.interview_final_transcript_reconciliation_claims
    where interview_id='${strong.interviewId}'
    for update;
    \\echo QUESTION_RACE_LOCKED
  `);
  await waitForOutput(lockHolder, 'QUESTION_RACE_LOCKED');

  const finalizer = spawnPsql();
  finalizer.end(`${finalizeSql(strong, strongClaim, {
    scores: strongClaim.scoringRequired ? undefined : null,
    summary: strongClaim.scoringRequired ? undefined : null,
  })}\n\\q\n`);
  await waitForBlockedQuery('finalize_interview_final_transcript_reconciliation');

  const staleWriter = spawnPsql();
  staleWriter.end(`${persistQuestionsSql(
    weak,
    weakClaim.version,
    weak.hash,
    ['Synthetic stale question?'],
  )}\n\\q\n`);
  await waitForBlockedQuery('persist_interview_unanswered_questions_if_authoritative');

  lockHolder.end('commit;\n\\q\n');
  assert.equal((await lockHolder.done).status, 0);
  const finalized = await finalizer.done;
  const stale = await staleWriter.done;
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(finalized.stdout.trim().split(/\r?\n/).at(-1).split('|')[0], 'finalized');
  assert.equal(stale.stdout.trim().split(/\r?\n/).at(-1), 'superseded');
  assert.equal(sql(`select unanswered_candidate_questions = '{}'::text[]
    from public.interviews where id='${strong.interviewId}';`).stdout, 't');
  assert.equal(
    sql(persistQuestionsSql(
      strong,
      strongClaim.version,
      strong.hash,
      ['Synthetic authoritative question?'],
    )).stdout,
    'stored',
  );
  assert.equal(sql(`select cardinality(unanswered_candidate_questions)
    from public.interviews where id='${strong.interviewId}';`).stdout, '1');
});

test('serialization DB 22. failed question persistence rolls back without changing reconciliation state', { skip: !ENABLED }, () => {
  const item = fixture(18);
  const claim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, claim)).stdout.split('|')[0], 'finalized');
  const claimBefore = sql(`select row_to_json(c)::text
    from private.interview_final_transcript_reconciliation_claims c
    where interview_id='${item.interviewId}';`).stdout;
  const interviewBefore = sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    status||'|'||attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||transcript_url
    from public.interviews where id='${item.interviewId}';`).stdout;

  sql(`
    create function public.synthetic_question_persistence_failure() returns trigger language plpgsql as $$
    begin
      if cardinality(new.unanswered_candidate_questions) > 0 then
        raise exception 'synthetic_question_persistence_failure';
      end if;
      return new;
    end $$;
    create trigger synthetic_question_persistence_failure
      before update on public.interviews for each row
      execute function public.synthetic_question_persistence_failure();
  `);
  const failed = sql(
    persistQuestionsSql(item, claim.version, item.hash, ['Synthetic rollback question?']),
    { allowFailure: true },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic_question_persistence_failure/i);
  assert.equal(sql(`select unanswered_candidate_questions = '{}'::text[]
    from public.interviews where id='${item.interviewId}';`).stdout, 't');
  assert.equal(sql(`select row_to_json(c)::text
    from private.interview_final_transcript_reconciliation_claims c
    where interview_id='${item.interviewId}';`).stdout, claimBefore);
  assert.equal(sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    status||'|'||attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||transcript_url
    from public.interviews where id='${item.interviewId}';`).stdout, interviewBefore);
  sql(`drop trigger synthetic_question_persistence_failure on public.interviews;
    drop function public.synthetic_question_persistence_failure();`);
});

test('serialization DB 23. Analysis V2 ownership fields and RPCs are private and least privilege', { skip: !ENABLED }, () => {
  assert.equal(sql(`select count(*)
    from pg_catalog.pg_attribute
    where attrelid='private.interview_final_transcript_reconciliation_claims'::regclass
      and attname in (
        'analysis_processing_state',
        'analysis_claim_token',
        'analysis_last_released_claim_token',
        'analysis_last_completed_claim_token',
        'analysis_claim_version',
        'analysis_lease_expires_at',
        'analysis_claimed_at',
        'analysis_completed_at',
        'analysis_expected_transcript_claim_version',
        'analysis_expected_transcript_hash',
        'analysis_completed_transcript_claim_version',
        'analysis_completed_transcript_hash',
        'analysis_last_failure_category'
      )
      and attnum>0
      and not attisdropped;`).stdout, '13');
  for (const signature of [
    'public.claim_interview_analysis_v2_if_authoritative(uuid,bigint,text,integer)',
    'public.finalize_interview_analysis_v2_if_authoritative(uuid,uuid,bigint,bigint,text,jsonb)',
    'public.release_interview_analysis_v2_claim(uuid,uuid,bigint,text)',
  ]) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(sql(`select has_function_privilege('${role}','${signature}','execute');`).stdout, 'f');
    }
    assert.equal(sql(`select has_function_privilege('service_role','${signature}','execute');`).stdout, 't');
    assert.equal(sql(`select prosecdef
        and coalesce(array_to_string(proconfig, ','), '') like '%search_path=""%'
      from pg_catalog.pg_proc
      where oid='${signature}'::regprocedure;`).stdout, 't');
  }
  assert.equal(sql(`select count(*)
    from pg_catalog.pg_proc p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid in (
      'public.claim_interview_analysis_v2_if_authoritative(uuid,bigint,text,integer)'::regprocedure,
      'public.finalize_interview_analysis_v2_if_authoritative(uuid,uuid,bigint,bigint,text,jsonb)'::regprocedure,
      'public.release_interview_analysis_v2_claim(uuid,uuid,bigint,text)'::regprocedure
    )
      and acl.grantee=0
      and acl.privilege_type='EXECUTE';`).stdout, '0');
});

test('serialization DB 24. twenty same-version Analysis V2 claims yield one owner and nineteen busy outcomes', { skip: !ENABLED }, async () => {
  const item = fixture(25);
  const transcriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, transcriptClaim)).stdout.split('|')[0], 'finalized');
  const results = await concurrentSql(Array.from(
    { length: 20 },
    () => claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const claims = results.map((result) => parseAnalysisV2Claim(result.stdout));
  assert.equal(claims.filter((claim) => claim.outcome === 'claimed').length, 1);
  assert.equal(claims.filter((claim) => claim.outcome === 'busy').length, 19);
  const winner = claims.find((claim) => claim.outcome === 'claimed');
  assert.equal(sql(releaseAnalysisV2Sql(item, winner)).stdout, 'released');
});

test('serialization DB 25. Analysis V2 lease recovery is single-owner and invalidates the old token/version', { skip: !ENABLED }, async () => {
  const item = fixture(26);
  const transcriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, transcriptClaim)).stdout.split('|')[0], 'finalized');
  const first = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ).stdout);
  assert.equal(first.outcome, 'claimed');
  assert.equal(parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ).stdout).outcome, 'busy');
  sql(`update private.interview_final_transcript_reconciliation_claims
    set analysis_claimed_at=now()-interval '2 seconds',
        analysis_lease_expires_at=now()-interval '1 second'
    where interview_id='${item.interviewId}';`);
  const results = await concurrentSql([
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ]);
  const recoveredClaims = results.map((result) => parseAnalysisV2Claim(result.stdout));
  assert.equal(recoveredClaims.filter((claim) => claim.outcome === 'recovered_expired_claim').length, 1);
  assert.equal(recoveredClaims.filter((claim) => claim.outcome === 'busy').length, 1);
  const recovered = recoveredClaims.find((claim) => claim.outcome === 'recovered_expired_claim');
  assert.equal(recovered.version, first.version + 1);
  assert.equal(
    sql(finalizeAnalysisV2Sql(
      item,
      first,
      transcriptClaim.version,
      item.hash,
      analysisV2(1),
    )).stdout,
    'stale_claim',
  );
  assert.equal(sql(releaseAnalysisV2Sql(item, recovered, 'worker_shutdown')).stdout, 'released');
});

test('serialization DB 26. stronger transcript analysis stores and a stale weaker worker cannot overwrite it', { skip: !ENABLED }, () => {
  const weak = fixture(27, {
    transcript: 'CANDIDATE: I built one synthetic system with measurable results.',
    snapshot: STRONG,
  });
  const weakTranscriptClaim = parseClaim(sql(claimSql(weak)).stdout);
  assert.equal(sql(finalizeSql(weak, weakTranscriptClaim)).stdout.split('|')[0], 'finalized');
  const weakAnalysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(weak, weakTranscriptClaim.version, weak.hash),
  ).stdout);
  assert.equal(weakAnalysisClaim.outcome, 'claimed');

  const strong = fixture(27, {
    transcript: 'CANDIDATE: I built two synthetic systems with measurable results.',
    snapshot: STRONGER,
  });
  const strongTranscriptClaim = parseClaim(sql(claimSql(strong)).stdout);
  assert.equal(strongTranscriptClaim.version, weakTranscriptClaim.version + 1);
  assert.equal(sql(finalizeSql(strong, strongTranscriptClaim, {
    scores: strongTranscriptClaim.scoringRequired ? undefined : null,
    summary: strongTranscriptClaim.scoringRequired ? undefined : null,
  })).stdout.split('|')[0], 'finalized');
  const strongAnalysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(strong, strongTranscriptClaim.version, strong.hash),
  ).stdout);
  assert.equal(strongAnalysisClaim.outcome, 'claimed');
  assert.equal(sql(finalizeAnalysisV2Sql(
    strong,
    strongAnalysisClaim,
    strongTranscriptClaim.version,
    strong.hash,
    analysisV2(2),
  )).stdout, 'stored');
  assert.equal(sql(finalizeAnalysisV2Sql(
    weak,
    weakAnalysisClaim,
    weakTranscriptClaim.version,
    weak.hash,
    analysisV2(1),
  )).stdout, 'stale_claim');
  assert.equal(sql(`select interview_analysis_v2->'scores'->>'response_specificity'
    from public.interviews where id='${strong.interviewId}';`).stdout, '72');
});

test('serialization DB 27. current, older-version, and historical unversioned analyses follow the compatibility contract', { skip: !ENABLED }, () => {
  const item = fixture(28);
  const firstTranscriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, firstTranscriptClaim)).stdout.split('|')[0], 'finalized');
  const firstAnalysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, firstTranscriptClaim.version, item.hash),
  ).stdout);
  assert.equal(sql(finalizeAnalysisV2Sql(
    item,
    firstAnalysisClaim,
    firstTranscriptClaim.version,
    item.hash,
    analysisV2(1),
  )).stdout, 'stored');
  assert.equal(parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, firstTranscriptClaim.version, item.hash),
  ).stdout).outcome, 'already_current');

  const stronger = fixture(28, {
    transcript: 'CANDIDATE: I built three synthetic systems with measurable results.',
    snapshot: STRONGER,
  });
  const strongerTranscriptClaim = parseClaim(sql(claimSql(stronger)).stdout);
  assert.equal(sql(finalizeSql(stronger, strongerTranscriptClaim, {
    scores: strongerTranscriptClaim.scoringRequired ? undefined : null,
    summary: strongerTranscriptClaim.scoringRequired ? undefined : null,
  })).stdout.split('|')[0], 'finalized');
  const strongerAnalysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(stronger, strongerTranscriptClaim.version, stronger.hash),
  ).stdout);
  assert.equal(strongerAnalysisClaim.outcome, 'claimed');
  assert.equal(sql(finalizeAnalysisV2Sql(
    stronger,
    strongerAnalysisClaim,
    strongerTranscriptClaim.version,
    stronger.hash,
    analysisV2(2),
  )).stdout, 'stored');

  const historical = fixture(29);
  const historicalTranscriptClaim = parseClaim(sql(claimSql(historical)).stdout);
  assert.equal(sql(finalizeSql(historical, historicalTranscriptClaim)).stdout.split('|')[0], 'finalized');
  sql(`update public.interviews
    set interview_analysis_v2=${json(analysisV2(3))}
    where id='${historical.interviewId}';`);
  assert.equal(parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(historical, historicalTranscriptClaim.version, historical.hash),
  ).stdout).outcome, 'analysis_present_unversioned');
  assert.equal(sql(`select interview_analysis_v2->'scores'->>'response_specificity'
    from public.interviews where id='${historical.interviewId}';`).stdout, '73');
});

test('serialization DB 28. invalid analysis, wrong ownership, and stale release fail closed', { skip: !ENABLED }, () => {
  const item = fixture(30);
  const transcriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, transcriptClaim)).stdout.split('|')[0], 'finalized');
  const analysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ).stdout);
  const wrongToken = {
    ...analysisClaim,
    token: '77000000-0000-4000-8000-000000000099',
  };
  const wrongVersion = { ...analysisClaim, version: analysisClaim.version + 1 };
  for (const invalidClaim of [wrongToken, wrongVersion]) {
    assert.equal(sql(finalizeAnalysisV2Sql(
      item,
      invalidClaim,
      transcriptClaim.version,
      item.hash,
      analysisV2(1),
    )).stdout, 'stale_claim');
    assert.equal(sql(releaseAnalysisV2Sql(item, invalidClaim)).stdout, 'claim_mismatch');
  }
  for (const invalidAnalysis of [
    null,
    [],
    {},
    { version: 'unknown' },
    analysisV2(1, { evidence_summary: 'x'.repeat(33_000) }),
  ]) {
    assert.equal(sql(finalizeAnalysisV2Sql(
      item,
      analysisClaim,
      transcriptClaim.version,
      item.hash,
      invalidAnalysis,
    )).stdout, 'invalid_analysis');
  }
  assert.equal(sql(releaseAnalysisV2Sql(item, analysisClaim)).stdout, 'released');
  assert.equal(sql(releaseAnalysisV2Sql(item, analysisClaim)).stdout, 'already_released');
});

test('serialization DB 29. concurrent Analysis V2 finalizers mutate once and duplicate completion is idempotent', { skip: !ENABLED }, async () => {
  const item = fixture(31);
  const transcriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, transcriptClaim)).stdout.split('|')[0], 'finalized');
  const analysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ).stdout);
  const statements = Array.from({ length: 2 }, () => finalizeAnalysisV2Sql(
    item,
    analysisClaim,
    transcriptClaim.version,
    item.hash,
    analysisV2(1),
  ));
  const results = await concurrentSql(statements);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const outcomes = results.map((result) => result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(outcomes.filter((outcome) => outcome === 'stored').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === 'already_current').length, 1);
});

test('serialization DB 30. Analysis V2 transactional failure rolls back result and ownership completion without unrelated mutation', { skip: !ENABLED }, () => {
  const item = fixture(32);
  const transcriptClaim = parseClaim(sql(claimSql(item)).stdout);
  assert.equal(sql(finalizeSql(item, transcriptClaim)).stdout.split('|')[0], 'finalized');
  const analysisClaim = parseAnalysisV2Claim(sql(
    claimAnalysisV2Sql(item, transcriptClaim.version, item.hash),
  ).stdout);
  const claimBefore = sql(`select row_to_json(c)::text
    from private.interview_final_transcript_reconciliation_claims c
    where interview_id='${item.interviewId}';`).stdout;
  const interviewBefore = sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    status||'|'||attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||transcript_url||'|'||
    coalesce(unanswered_candidate_questions::text,'')
    from public.interviews where id='${item.interviewId}';`).stdout;
  sql(`
    create function public.synthetic_analysis_v2_persistence_failure() returns trigger language plpgsql as $$
    begin
      if new.interview_analysis_v2 is not null then
        raise exception 'synthetic_analysis_v2_persistence_failure';
      end if;
      return new;
    end $$;
    create trigger synthetic_analysis_v2_persistence_failure
      before update on public.interviews for each row
      execute function public.synthetic_analysis_v2_persistence_failure();
  `);
  const failed = sql(finalizeAnalysisV2Sql(
    item,
    analysisClaim,
    transcriptClaim.version,
    item.hash,
    analysisV2(1),
  ), { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic_analysis_v2_persistence_failure/i);
  assert.equal(sql(`select interview_analysis_v2 is null
    from public.interviews where id='${item.interviewId}';`).stdout, 't');
  assert.equal(sql(`select row_to_json(c)::text
    from private.interview_final_transcript_reconciliation_claims c
    where interview_id='${item.interviewId}';`).stdout, claimBefore);
  assert.equal(sql(`select candidate_id||'|'||client_id||'|'||role_id||'|'||
    status||'|'||attempt_number||'|'||coalesce(previous_attempt_id::text,'')||'|'||
    coalesce(replacement_authorization_id::text,'')||'|'||transcript_url||'|'||
    coalesce(unanswered_candidate_questions::text,'')
    from public.interviews where id='${item.interviewId}';`).stdout, interviewBefore);
  sql(`drop trigger synthetic_analysis_v2_persistence_failure on public.interviews;
    drop function public.synthetic_analysis_v2_persistence_failure();`);
  assert.equal(sql(releaseAnalysisV2Sql(item, analysisClaim, 'analysis_finalize_failed')).stdout, 'released');
});

test('serialization DB 31. no prepared transaction or lingering test connection remains', { skip: !ENABLED }, () => {
  assert.equal(sql(`select
    (select count(*) from public.interviews)||'|'||
    (select count(*) from public.reports)||'|'||
    (select count(*) from public.interview_reset_events)||'|'||
    (select count(*) from public.interview_adjudications)||'|'||
    (select count(*) from public.interview_admin_audit_logs)||'|'||
    (select count(*) from private.interview_vendor_binding_recovery)||'|'||
    (select count(*) from public.otp_tokens)||'|'||
    (select count(*) from public.email_delivery_events);`).stdout, baselineInventory);
  assert.equal(sql(`select count(*) from pg_prepared_xacts where database='${DATABASE}';`).stdout, '0');
  assert.equal(sql(`select count(*) from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid();`).stdout, '0');
});

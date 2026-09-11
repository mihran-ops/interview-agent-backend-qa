'use strict';

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  fetchJson,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
  withTimeout,
} = require('./normalizePlatformHealth');

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeSupabaseErrorMessage(error, env, fallback = 'Supabase management check failed.') {
  let message = safeErrorMessage(error, fallback)
    .replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]')
    .slice(0, 180);
  for (const secret of [
    envValue(env, ['SUPABASE_ACCESS_TOKEN']),
    envValue(env, ['SUPABASE_PROJECT_REF']),
    envValue(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY']),
  ]) {
    if (secret) message = message.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
  }
  return message;
}

function supabaseHttpStatus(error) {
  return Number(error?.status || error?.statusCode || error?.$metadata?.httpStatusCode || 0) || null;
}

function supabaseManagementErrorKind(error) {
  if (error?.code === 'supabase_management_invalid_shape') return 'invalid_shape';
  if (error?.code === 'live_api_timeout' || error?.name === 'AbortError') return 'timeout';
  const status = supabaseHttpStatus(error);
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 409 || status === 429 || status >= 500) return 'unavailable';
  return status ? 'unknown' : 'unknown';
}

function managementStatusLabel(status) {
  if (status === 'connected') return 'Connected';
  if (status === 'failed') return 'Check failed';
  if (status === 'skipped') return 'Skipped';
  return 'Not configured';
}

function baseDiagnostics(env) {
  return {
    supabase_app_db_status: 'not_called',
    supabase_management_status: envConfigured(env, ['SUPABASE_ACCESS_TOKEN']) && envConfigured(env, ['SUPABASE_PROJECT_REF'])
      ? 'not_called'
      : 'not_configured',
    supabase_management_check: 'project',
    supabase_management_http_status: null,
    supabase_management_error_kind: null,
    supabase_project_scope: envConfigured(env, ['SUPABASE_PROJECT_REF']) ? 'present' : 'absent',
    supabase_management_auth: envConfigured(env, ['SUPABASE_ACCESS_TOKEN']) ? 'present' : 'absent',
  };
}

async function runDatabaseHealthCheck(context) {
  const started = Date.now();
  await withTimeout(
    context.db.from('clients').select('id').limit(1),
    Number(context.timeoutMs || 4000)
  );
  return Date.now() - started;
}

async function fetchSupabaseProject(context) {
  const projectRef = envValue(context.env, ['SUPABASE_PROJECT_REF']);
  const accessToken = envValue(context.env, ['SUPABASE_ACCESS_TOKEN']);
  const data = await fetchJson(context, `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('Supabase management response shape was not recognized.');
    error.code = 'supabase_management_invalid_shape';
    throw error;
  }
  return {
    region: trimText(data?.region || data?.database?.region) || null,
    status: trimText(data?.status || data?.database?.status) || null,
  };
}

async function buildSupabaseHealth(context) {
  const { env, now, signals, warnings } = context;
  const configured = envConfigured(env, ['SUPABASE_URL']) &&
    envConfigured(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY']);
  const managementConfigured = envConfigured(env, ['SUPABASE_ACCESS_TOKEN']) && envConfigured(env, ['SUPABASE_PROJECT_REF']);
  let responseMs = null;
  let dbError = null;
  let management = null;
  let managementError = null;
  const diagnostics = baseDiagnostics(env);
  const managementCheckEnabled = shouldRunLiveCheck(context, 'SUPABASE_METRICS_ENABLED');

  try {
    responseMs = await runDatabaseHealthCheck(context);
    diagnostics.supabase_app_db_status = 'connected';
  } catch (error) {
    dbError = error;
    diagnostics.supabase_app_db_status = 'failed';
  }

  if (managementConfigured && managementCheckEnabled) {
    try {
      management = await cachedLiveCall(
        context,
        `supabase:${envValue(env, ['SUPABASE_PROJECT_REF'])}`,
        () => fetchSupabaseProject(context)
      );
      diagnostics.supabase_management_status = 'connected';
    } catch (error) {
      managementError = error;
      diagnostics.supabase_management_status = 'failed';
      diagnostics.supabase_management_http_status = supabaseHttpStatus(error);
      diagnostics.supabase_management_error_kind = supabaseManagementErrorKind(error);
    }
  } else if (managementConfigured) {
    diagnostics.supabase_management_status = 'skipped';
  }

  const dbReachable = responseMs !== null && !dbError;
  const liveConnected = Boolean(management);
  const problem = Boolean(dbError);
  const warning = Boolean(managementError || warnings.length);
  const managementStatus = diagnostics.supabase_management_status;
  const managementLabel = managementStatusLabel(managementStatus);
  const sourceLabel = liveConnected
    ? 'Database health check and Supabase Management API'
    : 'Database health check';
  const sourceCode = liveConnected
    ? 'database_health_and_live_vendor_api'
    : 'database_health_check';
  const healthSummary = dbReachable
    ? liveConnected
      ? 'Database health check succeeded. Supabase Management API project status is connected.'
      : managementError
        ? 'Database health check succeeded. Supabase Management API check did not complete.'
        : managementStatus === 'skipped'
          ? 'Database health check succeeded. Supabase Management API check is disabled for this environment.'
          : 'Database health check succeeded. Supabase Management API is not configured, so project usage and cost signals are unavailable.'
    : 'Database health check did not complete.';

  return {
    key: 'supabase',
    name: 'Supabase',
    status: statusWithProblems({ configured, liveConnected: dbReachable || liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: dbReachable ? 'Connected' : configured ? 'Check failed' : 'Configuration missing',
    source_label: sourceLabel,
    source_code: sourceCode,
    meaning: 'Shows database, auth, and storage reachability for the alphaScreen app.',
    health_summary: healthSummary,
    usage_summary: [
      metric('App database health', dbReachable ? 'Connected' : 'Check failed', 'Primary Supabase signal: a small authenticated read against the app database.'),
      metric('Database response time', responseMs === null ? 'Not available' : `${responseMs} ms`, 'Time for a small read query through the configured Supabase client.'),
      metric('Clients loaded', signals.clients.length, 'Client rows loaded by the metrics endpoint.'),
      metric('Roles loaded', signals.roles.length, 'Role rows loaded by the metrics endpoint.'),
      metric('Candidates in range', signals.candidates.length, 'Candidate rows in the selected date range.'),
      metric('Management API', managementLabel, 'Optional project-level Supabase Management API check.'),
      metric('Project status', management ? management.status || 'Available' : 'Not available', 'Project-level status returned by the Supabase Management API when configured.'),
      metric('Project region', management ? management.region || 'Not available' : 'Not available', 'Region returned by the Supabase Management API; project reference is not exposed.'),
    ],
    problem_summary: [
      metric('Optional source warnings', warnings.length, 'Optional tables or columns unavailable while building the page.'),
      metric('Management API check', managementLabel, 'Missing Management API configuration does not make the app database unhealthy.'),
      metric('Usage and cost availability', 'Unavailable', 'Cost, database size, auth usage, storage usage, and quota usage are not returned by this lightweight check.'),
    ],
    cost_summary: costSummary({ help: 'Supabase cost, database size, auth usage, storage usage, and quota usage are unavailable through the current lightweight project-status check.' }),
    diagnostics,
    readiness_items: [
      readiness('App database client', configured ? 'Configured' : 'Missing', 'Required for alphaScreen database access.'),
      readiness('Database health check', dbReachable ? 'Passed' : 'Failed', dbError ? safeErrorMessage(dbError) : 'Small read query completed.'),
      readiness('Management API', managementLabel, 'Optional project-level status check. Not required for app database health.'),
    ],
    troubleshooting_note: dbError
      ? safeSupabaseErrorMessage(dbError, env, 'Supabase health check failed.')
      : managementError
        ? safeSupabaseErrorMessage(managementError, env, 'Supabase management check failed.')
        : null,
    last_checked: now.toISOString(),
    notes: [
      ...(!managementConfigured ? ['Supabase Management API is not configured; app database health is still checked.'] : []),
      ...(managementError ? ['Supabase Management API could not be read; app database health is still checked.'] : []),
    ],
  };
}

module.exports = { buildSupabaseHealth };

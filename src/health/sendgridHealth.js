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
} = require('./normalizePlatformHealth');

const DEFAULT_SENDGRID_STATUS_SUMMARY_URL = 'https://status.sendgrid.com/api/v2/summary.json';

function sendGridStatusUrl(env) {
  return envValue(env, ['SENDGRID_STATUS_SUMMARY_URL']) || DEFAULT_SENDGRID_STATUS_SUMMARY_URL;
}

function activeStatusItems(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const status = String(item?.status || '').toLowerCase();
    return status && !['resolved', 'completed'].includes(status);
  });
}

function limitedNames(values, limit = 6) {
  const names = [];
  const seen = new Set();
  for (const value of values) {
    const name = trimText(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function collectComponentNames(items = []) {
  const names = [];
  for (const item of items) {
    for (const component of Array.isArray(item?.components) ? item.components : []) {
      if (component?.name) names.push(component.name);
    }
  }
  return names;
}

function parseSendGridStatusSummary(data) {
  if (!data || typeof data !== 'object' || !data.status || typeof data.status !== 'object') {
    return { ok: false, errorKind: 'invalid_shape' };
  }
  const indicator = trimText(data.status.indicator) || null;
  const description = trimText(data.status.description) || (indicator ? indicator : 'Not available');
  const activeIncidents = activeStatusItems(data.incidents);
  const activeMaintenance = activeStatusItems(data.scheduled_maintenances);
  const affectedComponentNames = [
    ...(Array.isArray(data.components) ? data.components : [])
      .filter((component) => trimText(component?.status) && trimText(component.status).toLowerCase() !== 'operational')
      .map((component) => component.name),
    ...collectComponentNames(activeIncidents),
    ...collectComponentNames(activeMaintenance),
  ];
  return {
    ok: true,
    indicator,
    description,
    activeIncidentCount: activeIncidents.length,
    scheduledMaintenanceCount: activeMaintenance.length,
    affectedComponents: limitedNames(affectedComponentNames),
    pageUpdatedAt: trimText(data.page?.updated_at) || null,
  };
}

function sendGridStatusErrorKind(error) {
  if (error?.code === 'sendgrid_status_invalid_shape') return 'invalid_shape';
  if (error?.code === 'live_api_timeout') return 'timeout';
  if (error?.status) return 'http_error';
  return 'unknown';
}

function statusMetricValue(count, singular, plural = `${singular}s`) {
  if (!Number.isFinite(count)) return 'Not available';
  if (count === 0) return 'None';
  return `${count} ${count === 1 ? singular : plural}`;
}

async function fetchSendGridAccountCheck(context) {
  const data = await fetchJson(context, 'https://api.sendgrid.com/v3/scopes', {
    headers: {
      Authorization: `Bearer ${envValue(context.env, ['SENDGRID_API_KEY'])}`,
      'Content-Type': 'application/json',
    },
  });
  const scopes = Array.isArray(data?.scopes) ? data.scopes : Array.isArray(data) ? data : [];
  return { reachable: true, scopeCount: scopes.length };
}

async function fetchSendGridStatusPage(context) {
  const data = await fetchJson(context, sendGridStatusUrl(context.env), {
    headers: { Accept: 'application/json' },
  });
  const parsed = parseSendGridStatusSummary(data);
  if (!parsed.ok) {
    const error = new Error('SendGrid status page response shape was not recognized.');
    error.code = 'sendgrid_status_invalid_shape';
    throw error;
  }
  return parsed;
}

function sendGridSourceLabel({ apiConnected, statusPageConnected }) {
  if (apiConnected && statusPageConnected) return 'Live SendGrid API and SendGrid status page';
  if (apiConnected) return 'Live SendGrid API';
  if (statusPageConnected) return 'SendGrid status page';
  return 'Configuration check';
}

function sendGridSourceCode({ apiConnected, statusPageConnected }) {
  if (apiConnected && statusPageConnected) return 'live_sendgrid_api_and_status_page';
  if (apiConnected) return 'live_vendor_api';
  if (statusPageConnected) return 'sendgrid_status_page';
  return 'configuration_check';
}

async function buildSendGridHealth(context) {
  const { env, now } = context;
  const configured = envConfigured(env, ['SENDGRID_API_KEY']);
  const webhookConfigured = envConfigured(env, ['SENDGRID_EVENT_WEBHOOK_SECRET', 'SENDGRID_WEBHOOK_PUBLIC_KEY']);
  let apiCheck = null;
  let apiError = null;
  let statusPage = null;
  let statusError = null;
  const diagnostics = {
    sendgrid_api_connected: false,
    sendgrid_status_page_connected: false,
    sendgrid_status_indicator: null,
    sendgrid_active_incident_count: null,
    sendgrid_scheduled_maintenance_count: null,
    sendgrid_status_error_kind: null,
  };

  if (configured && shouldRunLiveCheck(context, 'SENDGRID_HEALTH_ENABLED')) {
    try {
      apiCheck = await cachedLiveCall(
        context,
        'sendgrid:api:scopes',
        () => fetchSendGridAccountCheck(context)
      );
    } catch (error) {
      apiError = error;
    }
  }

  if (shouldRunLiveCheck(context, 'SENDGRID_HEALTH_ENABLED')) {
    try {
      statusPage = await cachedLiveCall(
        context,
        `sendgrid-status:${sendGridStatusUrl(env)}`,
        () => fetchSendGridStatusPage(context)
      );
    } catch (error) {
      statusError = error;
    }
  }

  const apiConnected = Boolean(apiCheck?.reachable);
  const statusPageConnected = Boolean(statusPage);
  diagnostics.sendgrid_api_connected = apiConnected;
  diagnostics.sendgrid_status_page_connected = statusPageConnected;
  diagnostics.sendgrid_status_indicator = statusPage?.indicator || null;
  diagnostics.sendgrid_active_incident_count = statusPageConnected ? statusPage.activeIncidentCount : null;
  diagnostics.sendgrid_scheduled_maintenance_count = statusPageConnected ? statusPage.scheduledMaintenanceCount : null;
  diagnostics.sendgrid_status_error_kind = statusError ? sendGridStatusErrorKind(statusError) : null;

  const liveConnected = apiConnected || statusPageConnected;
  const statusIndicator = String(statusPage?.indicator || '').toLowerCase();
  const statusHasIncident = Boolean(statusPageConnected && (statusIndicator && statusIndicator !== 'none' || statusPage.activeIncidentCount > 0));
  const problem = ['major', 'critical'].includes(statusIndicator);
  const warning = Boolean(apiError || statusError || statusHasIncident || (configured && !apiConnected));
  const sourceLabel = sendGridSourceLabel({ apiConnected, statusPageConnected });

  return {
    key: 'sendgrid',
    name: 'SendGrid',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: sourceLabel,
    source_code: sendGridSourceCode({ apiConnected, statusPageConnected }),
    meaning: 'Shows SendGrid provider reachability and public platform status. Detailed delivery events remain in Audit Logs.',
    health_summary: apiConnected && statusPageConnected
      ? 'Using SendGrid API reachability and SendGrid public platform status.'
      : apiConnected
        ? 'Using SendGrid API reachability.'
        : statusPageConnected
          ? 'Using SendGrid public platform status.'
          : configured
            ? 'SendGrid API configuration exists, but provider status could not be read.'
            : 'SendGrid API key is not configured for this environment.',
    usage_summary: [
      metric('API key configured', configured ? 'Yes' : 'No', 'Whether this environment has a SendGrid API key configured.'),
      metric('SendGrid API reachability', apiError ? 'Check failed' : apiConnected ? 'Connected' : configured ? 'Not connected' : 'Not configured', 'A bounded account-level API check; no message-level delivery events are returned here.'),
      metric('SendGrid platform status', statusPage?.description || 'Not available', 'Public SendGrid platform status.'),
      metric('Active SendGrid incidents', statusMetricValue(statusPage?.activeIncidentCount, 'active incident'), 'Active unresolved incidents reported by the SendGrid status page.'),
      metric('Scheduled maintenance', statusMetricValue(statusPage?.scheduledMaintenanceCount, 'scheduled maintenance', 'scheduled maintenance windows'), 'Active scheduled maintenance reported by the SendGrid status page.'),
      metric('Affected components', statusPage?.affectedComponents?.length ? statusPage.affectedComponents.join(', ') : statusPageConnected ? 'None reported' : 'Not available', 'Affected SendGrid platform components reported by the status page.'),
      metric('Status page updated', statusPage?.pageUpdatedAt || 'Not available', 'Last updated timestamp reported by the SendGrid status page.'),
    ],
    problem_summary: [
      metric('API check', apiError ? 'Check failed' : apiConnected ? 'Connected' : configured ? 'Not connected' : 'Not configured', 'SendGrid API reachability only; message delivery diagnostics are intentionally not summarized here.'),
      metric('Status page check', statusError ? 'Check failed' : statusPageConnected ? 'Connected' : 'Not connected', 'Whether alphaScreen could read the public SendGrid status summary.'),
      metric('Delivery diagnostics', 'Audit Logs', 'Detailed SendGrid delivery/problem events are tracked outside Metrics.'),
    ],
    cost_summary: costSummary({ help: 'SendGrid cost is not available through the current status-only checks.' }),
    diagnostics,
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call SendGrid.'),
      readiness('API reachability', apiConnected ? 'Connected' : 'Not connected', 'Uses a bounded account-level API check when credentials are configured.'),
      readiness('SendGrid status page', statusPageConnected ? 'Connected' : 'Not connected', 'Reads the public SendGrid platform status summary.'),
      readiness('Webhook verification', webhookConfigured ? 'Configured' : 'Not configured', 'Shows whether webhook verification configuration is present.'),
    ],
    troubleshooting_note: apiError ? safeErrorMessage(apiError, 'SendGrid API check failed.') : statusError ? safeErrorMessage(statusError, 'SendGrid status page check failed.') : null,
    last_checked: now.toISOString(),
    notes: [
      'Detailed SendGrid delivery/problem events are tracked in Audit Logs, not Metrics.',
      ...(apiError ? ['SendGrid API reachability could not be confirmed.'] : []),
      ...(statusError ? ['SendGrid public status page could not be read.'] : []),
    ],
  };
}

module.exports = { buildSendGridHealth };

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

const DEFAULT_RENDER_STATUS_SUMMARY_URL = 'https://status.render.com/api/v2/summary.json';

function renderServiceIds(env) {
  const ids = [
    envValue(env, ['RENDER_BACKEND_SERVICE_ID', 'RENDER_QA_BACKEND_SERVICE_ID']),
    envValue(env, ['RENDER_FRONTEND_SERVICE_ID', 'RENDER_QA_FRONTEND_SERVICE_ID']),
  ].filter(Boolean);
  const combined = envValue(env, ['RENDER_SERVICE_IDS', 'RENDER_SERVICE_ID']);
  for (const part of combined.split(',')) {
    const id = trimText(part);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 4);
}

function renderStatusUrl(env) {
  return envValue(env, ['RENDER_STATUS_SUMMARY_URL']) || DEFAULT_RENDER_STATUS_SUMMARY_URL;
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

function parseRenderStatusSummary(data) {
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

function renderStatusErrorKind(error) {
  if (error?.code === 'render_status_invalid_shape') return 'invalid_shape';
  if (error?.code === 'live_api_timeout') return 'timeout';
  if (error?.status) return 'http_error';
  return 'unknown';
}

async function fetchRenderServices(context) {
  const headers = {
    Authorization: `Bearer ${envValue(context.env, ['RENDER_API_KEY'])}`,
    Accept: 'application/json',
  };
  const services = [];
  for (const id of renderServiceIds(context.env)) {
    const service = await fetchJson(context, `https://api.render.com/v1/services/${encodeURIComponent(id)}`, { headers });
    let deploy = null;
    try {
      const deploys = await fetchJson(context, `https://api.render.com/v1/services/${encodeURIComponent(id)}/deploys?limit=1`, { headers });
      deploy = Array.isArray(deploys) ? deploys[0] : Array.isArray(deploys?.data) ? deploys.data[0] : null;
    } catch {
      deploy = null;
    }
    services.push({
      name: service?.service?.name || service?.name || id,
      type: service?.service?.type || service?.type || 'service',
      suspended: service?.service?.suspended || service?.suspended || null,
      deployStatus: deploy?.deploy?.status || deploy?.status || null,
      deployCreatedAt: deploy?.deploy?.createdAt || deploy?.createdAt || null,
      deployFinishedAt: deploy?.deploy?.finishedAt || deploy?.finishedAt || null,
    });
  }
  return services;
}

async function fetchRenderStatusPage(context) {
  const data = await fetchJson(context, renderStatusUrl(context.env), {
    headers: { Accept: 'application/json' },
  });
  const parsed = parseRenderStatusSummary(data);
  if (!parsed.ok) {
    const error = new Error('Render status page response shape was not recognized.');
    error.code = 'render_status_invalid_shape';
    throw error;
  }
  return parsed;
}

function renderSourceLabel({ apiConnected, statusPageConnected }) {
  if (apiConnected && statusPageConnected) return 'Live Render API and Render status page';
  if (statusPageConnected) return 'Render status page';
  if (apiConnected) return 'Live Render API';
  return 'Configuration check';
}

function renderSourceCode({ apiConnected, statusPageConnected }) {
  if (apiConnected && statusPageConnected) return 'live_render_api_and_status_page';
  if (statusPageConnected) return 'render_status_page';
  if (apiConnected) return 'live_vendor_api';
  return 'configuration_check';
}

function statusMetricValue(count, singular, plural = `${singular}s`) {
  if (!Number.isFinite(count)) return 'Not available';
  if (count === 0) return 'None';
  return `${count} ${count === 1 ? singular : plural}`;
}

async function buildRenderHealth(context) {
  const { env, now } = context;
  const configured = envConfigured(env, ['RENDER_API_KEY']) && renderServiceIds(env).length > 0;
  let live = [];
  let liveError = null;
  let statusPage = null;
  let statusError = null;
  const diagnostics = {
    render_api_connected: false,
    render_status_page_connected: false,
    render_status_indicator: null,
    render_active_incident_count: null,
    render_scheduled_maintenance_count: null,
    render_status_error_kind: null,
  };

  if (configured && shouldRunLiveCheck(context, 'RENDER_METRICS_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `render:${renderServiceIds(env).join(',')}`,
        () => fetchRenderServices(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  if (shouldRunLiveCheck(context, 'RENDER_METRICS_ENABLED')) {
    try {
      statusPage = await cachedLiveCall(
        context,
        `render-status:${renderStatusUrl(env)}`,
        () => fetchRenderStatusPage(context)
      );
    } catch (error) {
      statusError = error;
    }
  }

  const apiConnected = live.length > 0;
  const statusPageConnected = Boolean(statusPage);
  diagnostics.render_api_connected = apiConnected;
  diagnostics.render_status_page_connected = statusPageConnected;
  diagnostics.render_status_indicator = statusPage?.indicator || null;
  diagnostics.render_active_incident_count = statusPageConnected ? statusPage.activeIncidentCount : null;
  diagnostics.render_scheduled_maintenance_count = statusPageConnected ? statusPage.scheduledMaintenanceCount : null;
  diagnostics.render_status_error_kind = statusError ? renderStatusErrorKind(statusError) : null;

  const liveConnected = apiConnected || statusPageConnected;
  const failedDeploys = live.filter((service) => /fail|cancel|error/i.test(String(service.deployStatus || ''))).length;
  const statusIndicator = String(statusPage?.indicator || '').toLowerCase();
  const statusHasIncident = Boolean(statusPageConnected && (statusIndicator && statusIndicator !== 'none' || statusPage.activeIncidentCount > 0));
  const warning = Boolean(liveError || failedDeploys > 0 || statusHasIncident || (configured && !apiConnected && !statusPageConnected));
  const problem = failedDeploys >= 2 || ['major', 'critical'].includes(statusIndicator);
  const sourceLabel = renderSourceLabel({ apiConnected, statusPageConnected });

  return {
    key: 'render',
    name: 'Render',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: sourceLabel,
    source_code: renderSourceCode({ apiConnected, statusPageConnected }),
    meaning: 'Shows app/API service deploy and runtime health.',
    health_summary: apiConnected && statusPageConnected
      ? 'Using Render API service/deploy status and Render public platform status.'
      : apiConnected
        ? 'Using Render API service and deploy status.'
        : statusPageConnected
          ? 'Using Render public platform status.'
      : configured
        ? 'Render API configuration is present, but live status could not be read.'
        : 'Render API is not configured for this environment.',
    usage_summary: [
      metric('Configured services', renderServiceIds(env).length, 'Render service identifiers configured for this environment.'),
      metric('Live services checked', live.length, 'Render services successfully read through the API.'),
      metric('Latest deploy status', live[0]?.deployStatus || 'Not available', 'Most recent deploy status from the first configured service.'),
      metric('Latest deploy time', live[0]?.deployFinishedAt || live[0]?.deployCreatedAt || 'Not available', 'Most recent deploy timestamp returned by Render.'),
      metric('Render platform status', statusPage?.description || 'Not available', 'Public Render platform status from status.render.com.'),
      metric('Active Render incidents', statusMetricValue(statusPage?.activeIncidentCount, 'active incident'), 'Active unresolved incidents reported by the Render status page.'),
      metric('Scheduled maintenance', statusMetricValue(statusPage?.scheduledMaintenanceCount, 'scheduled maintenance', 'scheduled maintenance windows'), 'Active scheduled maintenance reported by the Render status page.'),
      metric('Affected components', statusPage?.affectedComponents?.length ? statusPage.affectedComponents.join(', ') : statusPageConnected ? 'None reported' : 'Not available', 'Affected Render platform components reported by the status page.'),
      metric('Status page updated', statusPage?.pageUpdatedAt || 'Not available', 'Last updated timestamp reported by the Render status page.'),
    ],
    problem_summary: [
      metric('Failed deploys returned', failedDeploys, 'Configured Render services whose latest deploy returned a failed/canceled/error status.'),
      metric('Live service alerts', liveError ? 'Check failed' : liveConnected ? 'None returned' : 'Not connected', 'This page does not expose raw Render payloads.'),
      metric('Render status page check', statusError ? 'Check failed' : statusPageConnected ? 'Connected' : 'Not connected', 'Whether alphaScreen could read the public Render status summary.'),
    ],
    cost_summary: costSummary({ help: 'Render cost and runtime resource metrics are not available through the current service-status check.' }),
    diagnostics,
    readiness_items: [
      readiness('Credentials', envConfigured(env, ['RENDER_API_KEY']) ? 'Configured' : 'Missing', 'Required before alphaScreen can call Render.'),
      readiness('Service identifiers', renderServiceIds(env).length ? 'Configured' : 'Missing', 'Required to read backend/frontend service health.'),
      readiness('Service API', apiConnected ? 'Connected' : 'Not connected', 'Reads Render service and latest deploy status.'),
      readiness('Render status page', statusPageConnected ? 'Connected' : 'Not connected', 'Reads the public Render platform status summary.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Render live check failed.') : null,
    last_checked: now.toISOString(),
    notes: [
      ...(liveError ? ['Render API could not be read; current request health still succeeded.'] : []),
      ...(statusError ? ['Render status page could not be read; current request health still succeeded.'] : []),
    ],
  };
}

module.exports = { buildRenderHealth };

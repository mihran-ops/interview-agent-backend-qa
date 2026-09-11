'use strict';

const {
  costSummary,
  envConfigured,
  envEnabled,
  envValue,
  fetchJson,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
} = require('./normalizePlatformHealth');

const DEFAULT_SENTRY_API_BASE_URL = 'https://sentry.io/api/0';
const OPEN_SENTRY_STATUSES = new Set(['unresolved', 'open']);
const CLOSED_SENTRY_STATUSES = new Set(['resolved', 'ignored', 'archived', 'closed']);

function sentryProjects(env) {
  const projects = [
    envValue(env, ['SENTRY_PROJECT_BACKEND']),
    envValue(env, ['SENTRY_PROJECT_FRONTEND']),
    envValue(env, ['SENTRY_PROJECT']),
  ].filter(Boolean);
  const unique = [];
  for (const project of projects) {
    if (!unique.includes(project)) unique.push(project);
  }
  return unique.slice(0, 4);
}

function sentryPeriod(dateRange) {
  const from = dateRange?.from instanceof Date ? dateRange.from.getTime() : new Date(dateRange?.date_from || 0).getTime();
  const to = dateRange?.to instanceof Date ? dateRange.to.getTime() : new Date(dateRange?.date_to || Date.now()).getTime();
  const days = Math.max(1, Math.ceil((to - from) / (24 * 60 * 60 * 1000)));
  return `${Math.min(days, 90)}d`;
}

function stripSurroundingQuotes(value) {
  const text = trimText(value);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimText(text.slice(1, -1));
    }
  }
  return text;
}

function sentryAuthToken(env) {
  let token = stripSurroundingQuotes(envValue(env, ['SENTRY_AUTH_TOKEN']));
  token = token.replace(/^Bearer\s+/i, '').trim();
  return stripSurroundingQuotes(token);
}

function sentryApiBase(env) {
  const raw = envValue(env, ['SENTRY_API_BASE_URL']);
  if (!raw) {
    return {
      baseUrl: DEFAULT_SENTRY_API_BASE_URL,
      source: 'default',
      cacheKey: 'default:sentry.io:/api/0',
      error: null,
    };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.search || parsed.hash) {
      throw new Error('invalid_sentry_api_base_url');
    }
    const path = parsed.pathname.replace(/\/+$/, '');
    return {
      baseUrl: `${parsed.origin}${path}`,
      source: 'env',
      cacheKey: `env:${parsed.hostname}:${path}`,
      error: null,
    };
  } catch {
    const error = new Error('Invalid Sentry API base URL.');
    error.code = 'sentry_api_base_url_invalid';
    return {
      baseUrl: DEFAULT_SENTRY_API_BASE_URL,
      source: 'invalid',
      cacheKey: 'invalid',
      error,
    };
  }
}

function parseDateMs(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeIssueText(value, fallback = 'Not available') {
  const raw = trimText(value);
  if (!raw) return fallback;
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]')
    .slice(0, 180);
}

function safeSentryPermalink(value) {
  const raw = trimText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('sentry.io')) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeDateText(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function issueProjectSlug(issue) {
  if (issue?.project && typeof issue.project === 'object' && !Array.isArray(issue.project)) {
    return trimText(issue.project.slug || issue.project.name || issue.project.id);
  }
  return trimText(issue?.project);
}

function lowerIssueState(value) {
  return trimText(value).toLowerCase();
}

function issueStatusDetail(issue, field) {
  const details = issue?.statusDetails;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return '';
  return lowerIssueState(details[field]);
}

function isClosedSentrySubstatus(substatus) {
  if (!substatus) return false;
  return CLOSED_SENTRY_STATUSES.has(substatus)
    || substatus.startsWith('archived')
    || substatus.startsWith('ignored')
    || substatus.startsWith('resolved');
}

function hasSnoozeStatusDetails(issue) {
  const details = issue?.statusDetails;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  return Boolean(
    details.ignoreUntil
      || details.ignoreCount
      || details.ignoreWindow
      || details.ignoreUserCount
      || details.ignoreUserWindow
  );
}

function isOpenSentryIssue(issue) {
  const status = lowerIssueState(issue?.status);
  const statusDetailsStatus = issueStatusDetail(issue, 'status');
  const substatus = lowerIssueState(issue?.substatus) || issueStatusDetail(issue, 'substatus');

  if (CLOSED_SENTRY_STATUSES.has(status) || CLOSED_SENTRY_STATUSES.has(statusDetailsStatus)) return false;
  if (isClosedSentrySubstatus(substatus) || hasSnoozeStatusDetails(issue)) return false;

  return OPEN_SENTRY_STATUSES.has(status);
}

function safeIssueDetail(issue, project) {
  return {
    project: safeIssueText(project || issueProjectSlug(issue), 'Unknown project'),
    title: safeIssueText(issue?.title || issue?.metadata?.title || issue?.shortId || issue?.id),
    culprit: safeIssueText(issue?.culprit || issue?.metadata?.function || issue?.metadata?.filename || issue?.type),
    level: safeIssueText(issue?.level),
    status: safeIssueText(issue?.status),
    count: Number.isFinite(Number(issue?.count)) ? Number(issue.count) : null,
    user_count: Number.isFinite(Number(issue?.userCount)) ? Number(issue.userCount) : null,
    first_seen: safeDateText(issue?.firstSeen),
    last_seen: safeDateText(issue?.lastSeen),
    permalink: safeSentryPermalink(issue?.permalink),
    platform: safeIssueText(issue?.platform),
    environment: safeIssueText(issue?.environment || issue?.metadata?.environment),
  };
}

async function fetchSentryIssues(context) {
  const apiBase = sentryApiBase(context.env);
  if (apiBase.error) throw apiBase.error;
  const org = envValue(context.env, ['SENTRY_ORG']);
  const headers = {
    Authorization: `Bearer ${sentryAuthToken(context.env)}`,
    'Content-Type': 'application/json',
  };
  const period = sentryPeriod(context.dateRange);
  const projects = sentryProjects(context.env);
  const projectRows = [];
  const recentIssues = [];
  const fromMs = context.dateRange?.from instanceof Date
    ? context.dateRange.from.getTime()
    : parseDateMs(context.dateRange?.date_from);
  const url = new URL(`${apiBase.baseUrl}/organizations/${encodeURIComponent(org)}/issues/`);
  url.searchParams.set('query', 'is:unresolved');
  url.searchParams.set('statsPeriod', period);
  url.searchParams.set('sort', 'date');
  url.searchParams.set('limit', String(Math.min(25, Math.max(5, projects.length * 5))));
  for (const project of projects) {
    url.searchParams.append('project', project);
  }
  const data = await fetchJson(context, url.toString(), { headers });
  const allIssues = (Array.isArray(data) ? data : []).filter(isOpenSentryIssue);
  for (const project of projects) {
    const issues = allIssues.filter((issue) => issueProjectSlug(issue) === project);
    projectRows.push({
      project,
      unresolved: issues.length,
      newIssues: issues.filter((issue) => {
        const firstSeenMs = parseDateMs(issue?.firstSeen);
        return firstSeenMs && (!fromMs || firstSeenMs >= fromMs);
      }).length,
      latest: issues[0]?.lastSeen || issues[0]?.firstSeen || null,
    });
  }
  for (const issue of allIssues) {
    recentIssues.push(safeIssueDetail(issue, issueProjectSlug(issue)));
  }
  recentIssues.sort((left, right) => parseDateMs(right.last_seen || right.first_seen) - parseDateMs(left.last_seen || left.first_seen));
  return {
    projects: projectRows,
    recentIssues: recentIssues.slice(0, 5),
  };
}

async function buildSentryHealth(context) {
  const { env, now } = context;
  const apiBase = sentryApiBase(env);
  const projects = sentryProjects(env);
  const captureConfigured = envEnabled(env, 'SENTRY_ENABLED') && envConfigured(env, ['SENTRY_DSN']);
  const apiConfigured = Boolean(sentryAuthToken(env) && envConfigured(env, ['SENTRY_ORG']) && projects.length > 0);
  let live = null;
  let liveError = null;
  const diagnostics = {
    sentry_capture_configured: captureConfigured,
    sentry_api_status: apiConfigured ? 'not_called' : 'not_configured',
    sentry_project_count: projects.length,
    sentry_projects_checked: 0,
    sentry_recent_issue_count: 0,
    sentry_api_base_source: apiBase.source,
    sentry_issue_endpoint_source: 'organization_issues',
  };

  if (apiConfigured && shouldRunLiveCheck(context, 'SENTRY_METRICS_ENABLED')) {
    try {
      if (apiBase.error) throw apiBase.error;
      live = await fetchSentryIssues(context);
      diagnostics.sentry_api_status = 'connected';
    } catch (error) {
      liveError = error;
      diagnostics.sentry_api_status = 'failed';
    }
  } else if (apiConfigured) {
    diagnostics.sentry_api_status = 'skipped';
  }

  const projectRows = Array.isArray(live?.projects) ? live.projects : [];
  const recentIssues = Array.isArray(live?.recentIssues) ? live.recentIssues : [];
  const liveConnected = projectRows.length > 0;
  diagnostics.sentry_projects_checked = projectRows.length;
  diagnostics.sentry_recent_issue_count = recentIssues.length;
  const unresolved = projectRows.reduce((sum, row) => sum + Number(row.unresolved || 0), 0);
  const newIssues = projectRows.reduce((sum, row) => sum + Number(row.newIssues || 0), 0);
  const warning = Boolean(liveError || unresolved > 0 || (apiConfigured && !liveConnected) || (captureConfigured && !apiConfigured));

  return {
    key: 'sentry',
    name: 'Sentry',
    status: statusWithProblems({ configured: captureConfigured || apiConfigured, liveConnected, warning, problem: unresolved >= 10 }),
    configured: captureConfigured || apiConfigured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : apiConfigured ? 'Live API not connected' : captureConfigured ? 'Connected, usage unavailable' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API' : captureConfigured ? 'Configuration check' : 'Not connected yet',
    source_code: liveConnected ? 'live_vendor_api' : captureConfigured ? 'configuration_check' : 'not_connected',
    meaning: 'Shows captured frontend/backend errors and open issues.',
    health_summary: liveConnected
      ? 'Using Sentry API for unresolved issue counts.'
      : captureConfigured
        ? 'Sentry capture is configured; live issue counts are not connected.'
        : 'Sentry is not configured for this environment.',
    usage_summary: [
      metric('Capture configured', captureConfigured ? 'Yes' : 'No', 'Whether the app is configured to send errors to Sentry.'),
      metric('Projects configured', projects.length, 'Sentry project slugs configured for live issue checks.'),
      metric('Projects checked', projectRows.length, 'Projects successfully read through the Sentry API.'),
      metric('Recent issue details', liveConnected ? recentIssues.length : 'Not available', 'Sanitized unresolved issue details included for troubleshooting handoff when API access is connected.'),
    ],
    problem_summary: [
      metric('Open unresolved issues', liveConnected ? unresolved : 'Not available', 'Unresolved issue count returned by Sentry.'),
      metric('New issues in range', liveConnected ? newIssues : 'Not available', 'Issues returned by Sentry for the selected time window.'),
      metric('Most recent issue', projectRows.find((row) => row.latest)?.latest || 'Not available', 'Latest issue timestamp returned by Sentry.'),
    ],
    cost_summary: costSummary({ help: 'Sentry cost and event quota usage are not available through the current issue-count check.' }),
    recent_issues: recentIssues,
    diagnostics,
    readiness_items: [
      readiness('Capture setup', captureConfigured ? 'Configured' : 'Missing', 'Required before alphaScreen can send errors to Sentry.'),
      readiness('Issue API', liveConnected ? 'Connected' : 'Not connected', 'Requires Sentry organization, project, and API access.'),
      readiness('Projects', projects.length ? 'Configured' : 'Missing', 'Backend/frontend project slugs used for issue counts.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Sentry live issue check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['Sentry issue counts could not be read; capture configuration is still shown.'] : [],
  };
}

module.exports = { buildSentryHealth };

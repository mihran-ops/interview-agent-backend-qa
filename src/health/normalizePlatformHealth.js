'use strict';

const liveCache = new Map();

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;
const MISSING_REPORT_THRESHOLD_MS = 60 * 60 * 1000;
const RECORDING_THRESHOLD_MS = 60 * 60 * 1000;

function trimText(value) {
  return String(value == null ? '' : value).trim();
}

function lowerText(value) {
  return trimText(value).toLowerCase();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDateMs(value) {
  const raw = trimText(value);
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function unixSeconds(value) {
  const ms = value instanceof Date ? value.getTime() : parseDateMs(value);
  return Math.floor(ms / 1000);
}

function isoDateOnly(value) {
  const ms = value instanceof Date ? value.getTime() : parseDateMs(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '';
}

function metric(label, value, help = '') {
  return { label, value, help };
}

function readiness(label, status, help = '') {
  return { label, status, help };
}

function envValue(env, names) {
  for (const name of names || []) {
    const value = trimText(env?.[name]);
    if (value) return value;
  }
  return '';
}

function envConfigured(env, names) {
  return Boolean(envValue(env, names));
}

function envEnabled(env, name) {
  const value = lowerText(env?.[name]);
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function envDisabled(env, name) {
  const value = lowerText(env?.[name]);
  return value === '0' || value === 'false' || value === 'no' || value === 'off';
}

function shouldRunLiveCheck(context, flagName) {
  if (context?.liveChecksEnabled === false) return false;
  if (flagName && envDisabled(context?.env || {}, flagName)) return false;
  return true;
}

function getFetchImpl(context) {
  if (typeof context?.fetchImpl === 'function') return context.fetchImpl;
  if (typeof fetch === 'function') return fetch;
  return require('node-fetch');
}

function safeErrorMessage(error, fallback = 'Live check failed.') {
  const raw = trimText(error?.message || error?.detail || error?.code || fallback);
  if (!raw) return fallback;
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .slice(0, 220);
}

async function fetchJson(context, url, options = {}) {
  const fetchImpl = getFetchImpl(context);
  const timeoutMs = Number(options.timeoutMs || context?.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller?.signal,
    });
    const text = typeof response.text === 'function' ? await response.text() : '';
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const error = new Error(`Live API returned ${response.status || 'an error'}.`);
      error.status = response.status || null;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Timed out while checking live API.');
      timeoutError.code = 'live_api_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Timed out while checking live API.');
      error.code = 'live_api_timeout';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cachedLiveCall(context, cacheKey, producer) {
  const cacheEnabled = context?.cacheEnabled !== false;
  const nowMs = context?.now instanceof Date ? context.now.getTime() : Date.now();
  const ttlMs = Number(context?.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  if (cacheEnabled) {
    const cached = liveCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.value;
  }
  const value = await producer();
  if (cacheEnabled) {
    liveCache.set(cacheKey, { value, expiresAt: nowMs + ttlMs });
  }
  return value;
}

function costSummary({ value = null, currency = 'USD', sourceLabel = 'Not available', help = 'Live cost data is not available for this service.' } = {}) {
  const numeric = Number(value);
  const hasValue = value !== null && value !== undefined && value !== '' && Number.isFinite(numeric);
  const display = hasValue
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(numeric)
    : 'Not available';
  return {
    label: 'Cost this period',
    value: hasValue ? numeric : null,
    estimated: hasValue ? numeric : null,
    currency: currency || 'USD',
    display,
    source_label: sourceLabel,
    source: sourceLabel,
    help,
  };
}

function latestTimestamp(rows, fields) {
  let latest = 0;
  for (const row of rows || []) {
    for (const field of fields || []) {
      latest = Math.max(latest, parseDateMs(row?.[field]));
    }
  }
  return latest ? new Date(latest).toISOString() : null;
}

function problemRate(problem, total) {
  const safeTotal = Number(total || 0);
  if (!safeTotal) return 0;
  return Math.round((Number(problem || 0) / safeTotal) * 1000) / 10;
}

function countBy(rows, field) {
  return toArray(rows).reduce((counts, row) => {
    const key = lowerText(row?.[field]) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function normalizeEmailEvent(event) {
  const eventType = lowerText(event?.event_type || event?.event || event?.status);
  if (event?.is_problem === true) return 'problem';
  if (['processed', 'delivered', 'sent'].includes(eventType)) return 'sent_delivered';
  if (['open', 'click', 'group_resubscribe', 'group_unsubscribe', 'unsubscribe'].includes(eventType)) return 'engagement';
  if (['bounce', 'bounced', 'dropped', 'drop', 'blocked', 'deferred', 'spamreport', 'spam_report'].includes(eventType)) return 'problem';
  return 'unknown';
}

function reportKey(candidateId, roleId) {
  return `${trimText(candidateId)}:${trimText(roleId)}`;
}

function completedStatus(value) {
  const text = lowerText(value);
  return text.includes('complete') || text.includes('analyz') || text.includes('report');
}

function isCompletedInterview(interview, context) {
  if (completedStatus(interview?.status)) return true;
  const candidate = context.candidateById?.[interview?.candidate_id];
  if (completedStatus(candidate?.status) || completedStatus(candidate?.interview_status)) return true;
  return context.reportsByCandidateRole?.has(reportKey(interview?.candidate_id, interview?.role_id)) === true;
}

function interviewCompletedAt(interview, context) {
  if (completedStatus(interview?.status)) return interview?.updated_at || interview?.created_at || null;
  const candidate = context.candidateById?.[interview?.candidate_id];
  if (completedStatus(candidate?.status) || completedStatus(candidate?.interview_status)) {
    return interview?.updated_at || candidate?.updated_at || candidate?.created_at || interview?.created_at || null;
  }
  return context.reportCreatedAtByCandidateRole?.[reportKey(interview?.candidate_id, interview?.role_id)] || null;
}

function buildReportCreatedAtByCandidateRole(reports) {
  const byKey = {};
  for (const report of reports || []) {
    const key = reportKey(report?.candidate_id, report?.role_id);
    const created = trimText(report?.created_at);
    if (key !== ':' && created && (!byKey[key] || parseDateMs(created) > parseDateMs(byKey[key]))) {
      byKey[key] = created;
    }
  }
  return byKey;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isTranscriptReady(interview) {
  return Boolean(
    trimText(interview?.transcript) ||
    trimText(interview?.transcript_url) ||
    interview?.transcript_scores ||
    interview?.interview_analysis_v2
  );
}

function recordingStatus(interview) {
  const status = lowerText(interview?.recording_status);
  if (status.includes('delete') || trimText(interview?.recording_deleted_at)) return 'deleted';
  if (status.includes('fail') || status.includes('error') || status.includes('problem') || trimText(interview?.recording_delete_error)) return 'problem';
  if (status.includes('ready') || trimText(interview?.recording_ready_at) || parseMetadata(interview?.recording_metadata).s3_key) return 'ready';
  return 'pending';
}

function estimateRecordingMinutes(interviews) {
  let seconds = 0;
  for (const interview of interviews || []) {
    const metadata = parseMetadata(interview?.recording_metadata);
    const value = Number(metadata.duration_seconds ?? metadata.duration ?? metadata.duration_secs);
    if (Number.isFinite(value) && value > 0) seconds += value;
  }
  return seconds > 0 ? Math.round((seconds / 60) * 10) / 10 : null;
}

function buildAlphaScreenSignals({ rows, now }) {
  const clients = toArray(rows?.clients);
  const clientsBilling = toArray(rows?.clientsBilling);
  const roles = toArray(rows?.roles);
  const candidates = toArray(rows?.candidates);
  const interviews = toArray(rows?.interviews);
  const reports = toArray(rows?.reports);
  const perceptionEvents = toArray(rows?.perceptionEvents);
  const emailEvents = toArray(rows?.emailEvents);
  const cancellationRuns = toArray(rows?.cancellationRuns);
  const nowDate = now instanceof Date ? now : new Date();

  const candidateById = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  const reportsByCandidateRole = new Set(reports.map((report) => reportKey(report.candidate_id, report.role_id)));
  const reportCreatedAtByCandidateRole = buildReportCreatedAtByCandidateRole(reports);
  const completionContext = { candidateById, reportsByCandidateRole, reportCreatedAtByCandidateRole };
  const completedInterviews = interviews.filter((interview) => isCompletedInterview(interview, completionContext));
  const transcriptReady = interviews.filter(isTranscriptReady);
  const recordingCounts = interviews.reduce((counts, interview) => {
    const status = recordingStatus(interview);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const eventIds = new Set(perceptionEvents.map((event) => trimText(event.interview_id)).filter(Boolean));
  const missingReports = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview, completionContext));
    return completedMs && nowDate.getTime() - completedMs > MISSING_REPORT_THRESHOLD_MS &&
      !reportsByCandidateRole.has(reportKey(interview.candidate_id, interview.role_id));
  }).length;
  const perceptionMissing = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview, completionContext));
    return completedMs && nowDate.getTime() - completedMs > RECORDING_THRESHOLD_MS && !eventIds.has(trimText(interview.id));
  }).length;
  const emailCategoryCounts = emailEvents.reduce((counts, event) => {
    const category = normalizeEmailEvent(event);
    counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {});
  const emailEventTypeCounts = countBy(emailEvents, 'event_type');
  const emailProblems = Number(emailCategoryCounts.problem || 0);
  const failedCancellations = cancellationRuns.filter((row) => {
    const status = lowerText(row.status);
    return status.includes('fail') || trimText(row.error);
  }).length;

  return {
    clients,
    clientsBilling,
    roles,
    candidates,
    interviews,
    reports,
    perceptionEvents,
    emailEvents,
    cancellationRuns,
    completedInterviews,
    transcriptReady,
    recordingReady: Number(recordingCounts.ready || 0),
    recordingPending: Number(recordingCounts.pending || 0),
    recordingProblems: Number(recordingCounts.problem || 0),
    recordingDeleted: Number(recordingCounts.deleted || 0),
    recordingDeleteErrors: interviews.filter((interview) => trimText(interview.recording_delete_error)).length,
    estimatedMinutes: estimateRecordingMinutes(interviews),
    missingReports,
    perceptionMissing,
    lastReportAt: latestTimestamp(reports, ['created_at']),
    lastTavusWebhookAt: latestTimestamp(perceptionEvents, ['received_at', 'created_at']),
    lastEmailEventAt: latestTimestamp(emailEvents, ['event_at', 'created_at']),
    emailCategoryCounts,
    emailEventTypeCounts,
    emailProblems,
    emailProblemPercent: problemRate(emailProblems, emailEvents.length),
    bounced: Number(emailEventTypeCounts.bounce || 0) + Number(emailEventTypeCounts.bounced || 0),
    droppedBlockedDeferred:
      Number(emailEventTypeCounts.dropped || 0) + Number(emailEventTypeCounts.drop || 0) +
      Number(emailEventTypeCounts.blocked || 0) + Number(emailEventTypeCounts.deferred || 0),
    spamReports: Number(emailEventTypeCounts.spamreport || 0) + Number(emailEventTypeCounts.spam_report || 0),
    activeStripeClients: clientsBilling.filter((client) => ['active', 'trialing'].includes(lowerText(client.subscription_status))).length,
    trialingStripeClients: clientsBilling.filter((client) => lowerText(client.subscription_status) === 'trialing').length,
    stripeCustomers: clientsBilling.filter((client) => trimText(client.stripe_customer_id)).length,
    stripeSubscriptions: clientsBilling.filter((client) => trimText(client.stripe_subscription_id)).length,
    failedCancellations,
  };
}

function statusWithProblems({ configured, liveConnected, warning = false, problem = false }) {
  if (problem) return 'problem';
  if (warning) return 'warning';
  if (liveConnected) return 'healthy';
  if (configured) return 'warning';
  return 'not_configured';
}

function normalizeService(service) {
  const sourceLabel = trimText(service.source_label || service.sourceLabel || service.source) || 'Not connected yet';
  const usage = toArray(service.usage_summary || service.usage);
  const problems = toArray(service.problem_summary || service.problems || service.errors);
  const cost = service.cost_summary || service.cost || costSummary();
  return {
    key: service.key,
    name: service.name,
    status: service.status || 'unknown',
    configured: service.configured === 'unknown' ? 'unknown' : service.configured === true,
    live_connected: service.live_connected === true || service.live_api_connected === true,
    live_api_connected: service.live_api_connected === true || service.live_connected === true,
    connection_label: service.connection_label || (service.live_api_connected ? 'Connected' : service.configured ? 'Live API not connected' : 'Configuration missing'),
    source_label: sourceLabel,
    source: service.source_code || sourceLabel,
    meaning: service.meaning || '',
    health_summary: service.health_summary || service.health_detail || '',
    health_detail: service.health_detail || service.health_summary || '',
    usage_summary: usage,
    usage,
    problem_summary: problems,
    problems,
    errors: problems,
    cost_summary: cost,
    cost,
    recent_issues: toArray(service.recent_issues || service.recentIssues),
    readiness_items: toArray(service.readiness_items || service.readiness),
    readiness: toArray(service.readiness_items || service.readiness),
    diagnostics: service.diagnostics && typeof service.diagnostics === 'object' && !Array.isArray(service.diagnostics)
      ? service.diagnostics
      : undefined,
    last_checked: service.last_checked || new Date().toISOString(),
    troubleshooting_note: service.troubleshooting_note || null,
    notes: toArray(service.notes),
  };
}

function serviceFailure(key, name, error, now) {
  return normalizeService({
    key,
    name,
    status: 'unknown',
    configured: 'unknown',
    live_api_connected: false,
    connection_label: 'Check failed',
    source_label: 'Not connected yet',
    source_code: 'not_connected',
    meaning: 'Shows platform service health.',
    health_summary: 'This service check failed safely without stopping the page.',
    usage_summary: [metric('Usage this period', 'Not available', 'The service check did not complete.')],
    problem_summary: [metric('Check result', 'Check failed', 'The endpoint continued without returning raw vendor details.')],
    cost_summary: costSummary(),
    readiness_items: [readiness('Service check', 'Failed', safeErrorMessage(error))],
    troubleshooting_note: safeErrorMessage(error),
    last_checked: (now || new Date()).toISOString(),
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  buildAlphaScreenSignals,
  cachedLiveCall,
  costSummary,
  envConfigured,
  envDisabled,
  envEnabled,
  envValue,
  fetchJson,
  isoDateOnly,
  latestTimestamp,
  lowerText,
  metric,
  normalizeService,
  problemRate,
  readiness,
  safeErrorMessage,
  serviceFailure,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
  unixSeconds,
  withTimeout,
};

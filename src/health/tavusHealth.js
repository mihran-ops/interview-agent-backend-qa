'use strict';

const { isConfiguredTavusWebhookSecret } = require('../services/tavusWebhookAuth');
const { createTavusHttpClient } = require('../clients/tavus');

const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  trimText,
} = require('./normalizePlatformHealth');

const TAVUS_RECORDING_DELAY_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_TAVUS_RATE_CARD = {
  monthlyAllocationUsd: 59,
  includedConversationMinutes: 100,
  conversationMinuteRateUsd: 0.37,
  lipsyncMinuteRateUsd: 1.90,
  generatedVideoMinuteRateUsd: 1.10,
  replicaTrainingRateUsd: 65,
  blendedReferenceMinutes: 61.8,
};

function tavusApiBase(env) {
  const configured = envValue(env, ['TAVUS_API_BASE', 'TAVUS_API_BASE_URL']);
  return configured ? configured.replace(/\/+$/, '') : null;
}

function numberFromEnv(env, name, fallback) {
  const raw = envValue(env, [name]);
  if (!trimText(raw)) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function tavusRateCard(env) {
  return {
    monthlyAllocationUsd: numberFromEnv(env, 'TAVUS_MONTHLY_ALLOCATION_USD', DEFAULT_TAVUS_RATE_CARD.monthlyAllocationUsd),
    includedConversationMinutes: numberFromEnv(env, 'TAVUS_INCLUDED_CONVERSATION_MINUTES', DEFAULT_TAVUS_RATE_CARD.includedConversationMinutes),
    conversationMinuteRateUsd: numberFromEnv(env, 'TAVUS_CONVERSATION_MINUTE_RATE_USD', DEFAULT_TAVUS_RATE_CARD.conversationMinuteRateUsd),
    lipsyncMinuteRateUsd: numberFromEnv(env, 'TAVUS_LIPSYNC_MINUTE_RATE_USD', DEFAULT_TAVUS_RATE_CARD.lipsyncMinuteRateUsd),
    generatedVideoMinuteRateUsd: numberFromEnv(env, 'TAVUS_GENERATED_VIDEO_MINUTE_RATE_USD', DEFAULT_TAVUS_RATE_CARD.generatedVideoMinuteRateUsd),
    replicaTrainingRateUsd: numberFromEnv(env, 'TAVUS_REPLICA_TRAINING_RATE_USD', DEFAULT_TAVUS_RATE_CARD.replicaTrainingRateUsd),
    blendedReferenceMinutes: numberFromEnv(env, 'TAVUS_BLENDED_REFERENCE_MINUTES', DEFAULT_TAVUS_RATE_CARD.blendedReferenceMinutes),
  };
}

function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
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

function hasRecordingMetadata(value) {
  return Object.keys(parseMetadata(value)).length > 0;
}

function parseDateMs(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isVideoSessionRecord(interview) {
  return Boolean(
    trimText(interview?.video_url) ||
    trimText(interview?.recording_status) ||
    trimText(interview?.recording_ready_at) ||
    trimText(interview?.recording_deleted_at) ||
    trimText(interview?.recording_delete_error) ||
    hasRecordingMetadata(interview?.recording_metadata)
  );
}

function isProblemRecording(interview) {
  const status = String(interview?.recording_status || '').toLowerCase();
  return Boolean(
    status.includes('fail') ||
    status.includes('error') ||
    status.includes('problem') ||
    trimText(interview?.recording_delete_error)
  );
}

function isReadyOrDeletedRecording(interview) {
  const status = String(interview?.recording_status || '').toLowerCase();
  return Boolean(
    status.includes('ready') ||
    status.includes('delete') ||
    trimText(interview?.recording_ready_at) ||
    trimText(interview?.recording_deleted_at)
  );
}

function actionableTavusSignals(context) {
  const nowMs = context.now instanceof Date ? context.now.getTime() : Date.now();
  const interviews = Array.isArray(context.rows?.interviews) ? context.rows.interviews : [];
  const videoRecords = interviews.filter(isVideoSessionRecord);
  const problemRecords = videoRecords.filter(isProblemRecording);
  const delayedRecords = videoRecords.filter((interview) => {
    if (isProblemRecording(interview) || isReadyOrDeletedRecording(interview)) return false;
    const referenceMs = parseDateMs(interview.updated_at) || parseDateMs(interview.created_at);
    return referenceMs && nowMs - referenceMs > TAVUS_RECORDING_DELAY_THRESHOLD_MS;
  });
  return {
    recentProblemRecordings: problemRecords.length,
    recentDelayedRecordings: delayedRecords.length,
  };
}

function buildTavusCostEstimate({ env, estimatedMinutes }) {
  const minutes = Number(estimatedMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return {
      available: false,
      costSummary: costSummary({
        help: 'Tavus estimated cost is unavailable because recording duration metadata was not available for this period.',
      }),
      usageMetrics: [
        metric('Monthly allocation', `${formatUsd(DEFAULT_TAVUS_RATE_CARD.monthlyAllocationUsd)}/month`, 'Included monthly Tavus allocation from the invoice rate card.'),
        metric('Estimated conversation minutes', 'Not available', 'Estimated from alphaScreen recording metadata when duration is present.'),
      ],
      note: null,
    };
  }

  const rateCard = tavusRateCard(env);
  const overageMinutes = Math.max(0, minutes - rateCard.includedConversationMinutes);
  const variableConversationCost = overageMinutes * rateCard.conversationMinuteRateUsd;
  const lipsyncMinutes = 0;
  const generatedVideoMinutes = 0;
  const replicasTrained = 0;
  const lipsyncCost = lipsyncMinutes * rateCard.lipsyncMinuteRateUsd;
  const generatedVideoCost = generatedVideoMinutes * rateCard.generatedVideoMinuteRateUsd;
  const replicaTrainingCost = replicasTrained * rateCard.replicaTrainingRateUsd;
  const variableUsageCost = roundCurrency(variableConversationCost + lipsyncCost + generatedVideoCost + replicaTrainingCost);
  const blendedMinuteCost = rateCard.blendedReferenceMinutes > 0
    ? rateCard.monthlyAllocationUsd / rateCard.blendedReferenceMinutes
    : null;
  const blendedAllocationEstimate = blendedMinuteCost === null ? null : roundCurrency(minutes * blendedMinuteCost);

  return {
    available: true,
    variableUsageCost,
    overageMinutes: Math.round(overageMinutes * 10) / 10,
    blendedAllocationEstimate,
    costSummary: costSummary({
      value: variableUsageCost,
      currency: 'USD',
      sourceLabel: 'Estimated from Tavus invoice rate card',
      help: 'Variable usage estimate based on invoice rates. This is an internal estimate, not a Tavus invoice.',
    }),
    usageMetrics: [
      metric('Monthly allocation', `${formatUsd(rateCard.monthlyAllocationUsd)}/month`, 'Included monthly Tavus allocation from the invoice rate card.'),
      metric('Estimated conversation minutes', Math.round(minutes * 10) / 10, 'Estimated from alphaScreen recording metadata.'),
      metric('Included conversation minutes', `First ${rateCard.includedConversationMinutes}`, 'Conversation minutes included before variable overage estimate.'),
      metric('Conversation overage minutes', Math.round(overageMinutes * 10) / 10, 'Estimated conversation minutes above the included tier.'),
      metric('Estimated variable usage cost', formatUsd(variableUsageCost), 'Estimated Tavus variable usage above included tiers.'),
      metric('Estimated blended allocation', blendedAllocationEstimate === null ? 'Not available' : formatUsd(blendedAllocationEstimate), 'Monthly allocation spread across observed usage using the invoice reference minutes.'),
    ],
    note: 'Variable usage estimates additional Tavus usage above included tiers. Blended allocation spreads the monthly Tavus allocation across observed usage. These are internal estimates, not Tavus invoice totals.',
  };
}

async function fetchTavusConversationPage(context) {
  const transport = typeof context.fetchImpl === 'function'
    ? async (url, options) => {
        const response = await context.fetchImpl(url, options);
        return {
          statusCode: response.status,
          headers: response.headers,
          body: { text: () => response.text() },
        };
      }
    : undefined;
  const client = context.tavusHttpClient || createTavusHttpClient({
    apiKey: envValue(context.env, ['TAVUS_API_KEY']),
    baseUrl: tavusApiBase(context.env),
    transport,
  });
  const data = await client.listConversations({ limit: 100 }, { health: true });
  const rows = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.conversations)
      ? data.conversations
      : Array.isArray(data)
        ? data
        : [];
  return {
    returned: rows.length,
    statuses: rows.reduce((counts, row) => {
      const status = trimText(row?.status || row?.conversation_status || row?.state) || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
  };
}

async function buildTavusHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['TAVUS_API_KEY']);
  const webhookConfigured = isConfiguredTavusWebhookSecret(env);
  const canCheckLive = configured && shouldRunLiveCheck(context, 'TAVUS_USAGE_ENABLED');
  let live = null;
  let liveError = null;

  if (canCheckLive) {
    try {
      live = await cachedLiveCall(
        context,
        `tavus:${context.dateRange.date_from}:${context.dateRange.date_to}:${tavusApiBase(env) || 'default'}`,
        () => fetchTavusConversationPage(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live);
  const actionable = actionableTavusSignals(context);
  const warningReasons = [
    ...(liveConnected && !webhookConfigured ? ['webhook_verification_not_configured'] : []),
    ...(liveConnected && actionable.recentDelayedRecordings > 0 ? ['recording_delivery_delayed'] : []),
  ];
  const problemReasons = [
    ...(!configured ? ['credentials_missing'] : []),
    ...(liveError ? ['api_unreachable'] : []),
    ...(actionable.recentProblemRecordings > 0 ? ['recording_problem_state'] : []),
  ];
  const problem = problemReasons.length > 0;
  const warning = !problem && warningReasons.length > 0;
  const sourceLabel = liveConnected ? 'Live vendor API and alphaScreen records' : 'alphaScreen recording and webhook records';
  const costEstimate = buildTavusCostEstimate({ env, estimatedMinutes: signals.estimatedMinutes });
  const diagnostics = {
    tavus_api_connected: liveConnected,
    tavus_webhook_recent_event_present: Boolean(signals.lastTavusWebhookAt),
    tavus_warning_reason_count: warningReasons.length,
    tavus_cost_source: costEstimate.available ? 'invoice_rate_card' : 'unavailable',
    tavus_estimated_minutes_source: signals.estimatedMinutes === null ? 'unavailable' : 'recording_metadata',
    tavus_variable_cost_calculated: costEstimate.available,
  };

  return {
    key: 'tavus',
    name: 'Tavus',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: sourceLabel,
    source_code: liveConnected ? 'live_vendor_api' : 'alphascreen_records',
    meaning: 'Shows video screening session, recording, transcript, and perception health.',
    health_summary: problem
      ? 'Tavus API or webhook connectivity failed.'
      : warning
        ? 'Tavus API is reachable, but recent recording or webhook processing issues need review.'
        : liveConnected
          ? 'Tavus API is reachable. No recent Tavus connectivity or webhook processing issues were found.'
          : configured
            ? 'Using alphaScreen recording and webhook records because live Tavus usage is not connected.'
            : 'Tavus credentials are not configured for this environment.',
    usage_summary: [
      metric('Interview starts', signals.interviews.length, 'Interview rows created in the selected date range.'),
      metric('Recording ready', signals.recordingReady, 'Recordings marked ready by Tavus webhook processing.'),
      metric('Transcript ready', signals.transcriptReady.length, 'Interviews with transcript data available.'),
      metric('Perception events', signals.perceptionEvents.length, 'Tavus perception webhook events stored by alphaScreen.'),
      metric('Estimated minutes', signals.estimatedMinutes === null ? 'Not available' : signals.estimatedMinutes, 'Estimated from recording metadata when duration is present.'),
      ...(liveConnected ? [metric('Live conversations returned', live.returned, 'Latest conversation page returned by Tavus API.')] : []),
      ...costEstimate.usageMetrics,
    ],
    problem_summary: [
      metric('Pending/problem recordings', signals.recordingPending + signals.recordingProblems, 'Recordings not ready or marked problem in alphaScreen records.'),
      metric('Deleted recordings', signals.recordingDeleted, 'Recordings marked deleted in alphaScreen records.'),
      metric('Perception missing proxy', signals.perceptionMissing, 'Informational proxy only; not classified as a Tavus warning by itself.'),
      metric('Last webhook event', signals.lastTavusWebhookAt || 'Not available', 'Informational only; no recent Tavus webhook event is not a problem by itself.'),
      metric('Actionable recording delays', actionable.recentDelayedRecordings, 'Recent Tavus video sessions with recording/transcript/perception delivery delayed beyond the threshold.'),
      metric('Persistent recording problems', actionable.recentProblemRecordings, 'Recent Tavus video sessions with failed/error/problem recording states.'),
    ],
    cost_summary: costEstimate.costSummary,
    diagnostics,
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call Tavus.'),
      readiness('Webhook receiver', signals.lastTavusWebhookAt ? 'Receiving events' : 'No recent events', 'Based on Tavus webhook rows stored by alphaScreen.'),
      readiness('Webhook verification', webhookConfigured ? 'Configured' : 'Not configured', 'Shows whether webhook verification configuration is present.'),
      readiness('Live usage API', liveConnected ? 'Connected' : 'Not connected', 'The adapter checks Tavus API reachability and uses records for selected-period totals.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'Tavus live check failed.') : null,
    last_checked: now.toISOString(),
    notes: [
      ...(liveError ? ['Tavus live API could not be read; alphaScreen recording records are still shown.'] : []),
      ...(costEstimate.note ? [costEstimate.note] : []),
    ],
  };
}

module.exports = { buildTavusHealth };

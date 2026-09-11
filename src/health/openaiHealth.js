'use strict';

const {
  DEFAULT_TIMEOUT_MS,
  cachedLiveCall,
  costSummary,
  envConfigured,
  envDisabled,
  envValue,
  fetchJson,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  unixSeconds,
} = require('./normalizePlatformHealth');

function openAIHeaders(env) {
  const headers = {
    Authorization: `Bearer ${envValue(env, ['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY'])}`,
    'Content-Type': 'application/json',
  };
  const orgId = envValue(env, ['OPENAI_ORG_ID', 'OPENAI_ORGANIZATION_ID']);
  const projectId = envValue(env, ['OPENAI_PROJECT_ID']);
  if (orgId) headers['OpenAI-Organization'] = orgId;
  if (projectId) headers['OpenAI-Project'] = projectId;
  return headers;
}

function openAIKeySource(env) {
  if (envConfigured(env, ['OPENAI_ADMIN_KEY'])) return 'admin_key';
  if (envConfigured(env, ['OPENAI_API_KEY'])) return 'standard_key';
  return 'missing';
}

function openAICostSkipStatus(env, fallback = 'skipped_before_request') {
  if (envDisabled(env, 'OPENAI_COSTS_ENABLED') || envDisabled(env, 'OPENAI_USAGE_ENABLED')) return 'skipped_by_env';
  if (!envConfigured(env, ['OPENAI_ADMIN_KEY'])) return 'skipped_missing_admin_key';
  return fallback;
}

function baseOpenAIDiagnostics(env) {
  return {
    openai_usage_status: 'not_called',
    openai_cost_status: 'not_called',
    openai_cost_call_status: openAICostSkipStatus(env),
    openai_cost_http_status: null,
    openai_cost_error_kind: null,
    openai_cost_endpoint_version: 'organization_costs',
    openai_cost_response_kind: 'not_called',
    openai_cost_bucket_count: null,
    openai_cost_total_seen: false,
    openai_cost_request_attempted: false,
    openai_cost_request_url_valid: false,
    openai_cost_query_param_keys: [],
    openai_cost_exception_kind: null,
    openai_cost_exception_message_safe: null,
    openai_key_source: openAIKeySource(env),
    openai_project_scope: envConfigured(env, ['OPENAI_PROJECT_ID']) ? 'present' : 'absent',
    openai_org_scope: envConfigured(env, ['OPENAI_ORG_ID', 'OPENAI_ORGANIZATION_ID']) ? 'present' : 'absent',
  };
}

function openAIErrorKind(error) {
  const status = Number(error?.status || 0);
  if (status === 401 || status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 408 || status === 409 || status === 429 || status >= 500 || error?.code === 'live_api_timeout' || error?.name === 'TypeError') return 'unavailable';
  return status ? 'unknown' : 'unknown';
}

function openAIExceptionKind(error) {
  const message = String(error?.message || '');
  if (error?.name === 'AbortError' || error?.code === 'live_api_timeout') return 'abort';
  if (error?.code === 'ERR_INVALID_URL' || /invalid url/i.test(message)) return 'url';
  if (error?.code === 'openai_cost_parse_error') return 'parse';
  if (error?.name === 'TypeError') return 'fetch';
  return 'unknown';
}

function safeOpenAIExceptionMessage(error) {
  return safeErrorMessage(error, 'OpenAI cost request failed.')
    .replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]')
    .replace(/[?&][A-Za-z0-9_./~%+-]+=[A-Za-z0-9_./~%+-]+/g, '')
    .slice(0, 160);
}

function getFetchImpl(context) {
  if (typeof context?.fetchImpl === 'function') return context.fetchImpl;
  if (typeof fetch === 'function') return fetch;
  return require('node-fetch');
}

function sumOpenAIUsage(data) {
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    models: new Set(),
  };
  for (const bucket of Array.isArray(data?.data) ? data.data : []) {
    for (const result of Array.isArray(bucket?.results) ? bucket.results : []) {
      totals.requests += Number(result?.num_model_requests || result?.num_requests || 0);
      totals.inputTokens += Number(result?.input_tokens || 0);
      totals.outputTokens += Number(result?.output_tokens || 0);
      if (result?.model) totals.models.add(String(result.model));
    }
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

function parseOpenAICost(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.data)) {
    return {
      valid: false,
      responseKind: 'invalid_shape',
      bucketCount: null,
      totalSeen: false,
      cost: null,
    };
  }

  let value = 0;
  let currency = 'USD';
  let resultCount = 0;
  let totalSeen = false;
  for (const bucket of data.data) {
    if (!bucket || typeof bucket !== 'object' || !Array.isArray(bucket.results)) {
      return {
        valid: false,
        responseKind: 'invalid_shape',
        bucketCount: data.data.length,
        totalSeen,
        cost: null,
      };
    }

    for (const result of bucket.results) {
      if (!result || typeof result !== 'object') {
        return {
          valid: false,
          responseKind: 'invalid_shape',
          bucketCount: data.data.length,
          totalSeen,
          cost: null,
        };
      }

      resultCount += 1;
      const amount = result?.amount || {};
      const amountValue = Number(amount.value);
      if (Number.isFinite(amountValue)) {
        value += amountValue;
        totalSeen = true;
      }
      if (amount.currency) currency = String(amount.currency).toUpperCase();
    }
  }

  return {
    valid: true,
    responseKind: resultCount > 0 ? 'buckets' : 'empty_buckets',
    bucketCount: data.data.length,
    totalSeen,
    cost: {
      value: Math.round(value * 100) / 100,
      currency,
      note: totalSeen ? null : 'No cost returned for selected period',
    },
  };
}

function buildOpenAICostsUrl({ context, env, start, end }) {
  const base = context?.openAICostOrganizationBaseUrl || 'https://api.openai.com/v1/organization';
  const costsUrl = new URL(`${base}/costs`);
  costsUrl.searchParams.set('start_time', String(start));
  costsUrl.searchParams.set('end_time', String(end));
  costsUrl.searchParams.set('bucket_width', '1d');
  costsUrl.searchParams.set('limit', '180');
  const projectId = envValue(env, ['OPENAI_PROJECT_ID']);
  if (projectId) costsUrl.searchParams.append('project_ids', projectId);
  return costsUrl;
}

async function fetchOpenAICostResponse(context, url, options = {}) {
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
    let parseError = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        parseError = error;
        parseError.code = 'openai_cost_parse_error';
      }
    }
    return {
      ok: response.ok === true,
      status: Number(response.status || 0) || null,
      data,
      parseError,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Timed out while checking OpenAI costs.');
      timeoutError.code = 'live_api_timeout';
      timeoutError.name = 'AbortError';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchOpenAIUsage(context) {
  const { env, dateRange } = context;
  const diagnostics = baseOpenAIDiagnostics(env);
  const start = unixSeconds(dateRange.from);
  const end = unixSeconds(dateRange.to);
  const headers = openAIHeaders(env);
  const base = 'https://api.openai.com/v1/organization';
  const usageUrl = new URL(`${base}/usage/completions`);
  usageUrl.searchParams.set('start_time', String(start));
  usageUrl.searchParams.set('end_time', String(end));
  usageUrl.searchParams.set('bucket_width', '1d');
  usageUrl.searchParams.set('group_by', 'model');
  usageUrl.searchParams.set('limit', '31');

  let usageData = null;
  try {
    usageData = await fetchJson(context, usageUrl.toString(), { headers });
    diagnostics.openai_usage_status = 'connected';
  } catch (error) {
    diagnostics.openai_usage_status = 'failed';
    diagnostics.openai_cost_status = 'not_called';
    diagnostics.openai_cost_call_status = openAICostSkipStatus(env);
    error.diagnostics = diagnostics;
    throw error;
  }

  const costSkipStatus = openAICostSkipStatus(env, null);
  if (costSkipStatus) {
    diagnostics.openai_cost_status = 'not_called';
    diagnostics.openai_cost_call_status = costSkipStatus;
    return {
      usage: sumOpenAIUsage(usageData),
      cost: null,
      diagnostics,
    };
  }

  let costData = null;
  let costResponse = null;
  let costsUrl = null;
  try {
    costsUrl = buildOpenAICostsUrl({ context, env, start, end });
    diagnostics.openai_cost_request_url_valid = true;
    diagnostics.openai_cost_query_param_keys = Array.from(new Set(costsUrl.searchParams.keys()));
  } catch (error) {
    diagnostics.openai_cost_status = 'failed';
    diagnostics.openai_cost_call_status = 'called_failed';
    diagnostics.openai_cost_response_kind = 'request_exception';
    diagnostics.openai_cost_error_kind = 'unknown';
    diagnostics.openai_cost_exception_kind = openAIExceptionKind(error);
    diagnostics.openai_cost_exception_message_safe = safeOpenAIExceptionMessage(error);
    return {
      usage: sumOpenAIUsage(usageData),
      cost: null,
      diagnostics,
    };
  }

  try {
    diagnostics.openai_cost_call_status = 'skipped_before_request';
    diagnostics.openai_cost_request_attempted = true;
    costResponse = await fetchOpenAICostResponse(context, costsUrl.toString(), { headers });
    diagnostics.openai_cost_http_status = costResponse.status;
    costData = costResponse.data;
  } catch (error) {
    diagnostics.openai_cost_status = 'failed';
    diagnostics.openai_cost_call_status = 'called_failed';
    diagnostics.openai_cost_response_kind = 'request_exception';
    diagnostics.openai_cost_error_kind = openAIErrorKind(error);
    diagnostics.openai_cost_exception_kind = openAIExceptionKind(error);
    diagnostics.openai_cost_exception_message_safe = safeOpenAIExceptionMessage(error);
    costData = null;
  }

  if (costResponse && !costResponse.ok) {
    diagnostics.openai_cost_status = 'failed';
    diagnostics.openai_cost_call_status = 'called_failed';
    diagnostics.openai_cost_response_kind = 'http_error';
    diagnostics.openai_cost_error_kind = openAIErrorKind({ status: costResponse.status });
    return {
      usage: sumOpenAIUsage(usageData),
      cost: null,
      diagnostics,
    };
  }

  if (costResponse?.parseError) {
    diagnostics.openai_cost_status = 'failed';
    diagnostics.openai_cost_call_status = 'called_failed';
    diagnostics.openai_cost_response_kind = 'invalid_shape';
    diagnostics.openai_cost_error_kind = 'unknown';
    diagnostics.openai_cost_exception_kind = 'parse';
    diagnostics.openai_cost_exception_message_safe = safeOpenAIExceptionMessage(costResponse.parseError);
    return {
      usage: sumOpenAIUsage(usageData),
      cost: null,
      diagnostics,
    };
  }

  const costResult = costResponse ? parseOpenAICost(costData) : null;
  if (costResult) {
    diagnostics.openai_cost_response_kind = costResult.responseKind;
    diagnostics.openai_cost_bucket_count = costResult.bucketCount;
    diagnostics.openai_cost_total_seen = costResult.totalSeen;
    if (costResult.valid) {
      diagnostics.openai_cost_status = 'connected';
      diagnostics.openai_cost_call_status = 'called_connected';
      diagnostics.openai_cost_error_kind = null;
    } else {
      diagnostics.openai_cost_status = 'failed';
      diagnostics.openai_cost_call_status = 'called_failed';
      diagnostics.openai_cost_error_kind = 'unknown';
    }
  }
  return {
    usage: sumOpenAIUsage(usageData),
    cost: costResult?.valid ? costResult.cost : null,
    diagnostics,
  };
}

async function buildOpenAIHealth(context) {
  const { env, now, signals } = context;
  const configured = envConfigured(env, ['OPENAI_ADMIN_KEY', 'OPENAI_API_KEY']);
  const canCheckLive = configured && shouldRunLiveCheck(context, 'OPENAI_USAGE_ENABLED');
  let live = null;
  let liveError = null;
  let diagnostics = baseOpenAIDiagnostics(env);

  if (configured && !canCheckLive) {
    diagnostics.openai_cost_call_status = context.liveChecksEnabled === false
      ? 'skipped_by_env'
      : openAICostSkipStatus(env);
  }

  if (canCheckLive) {
    try {
      live = await cachedLiveCall(
        context,
        `openai:${context.dateRange.date_from}:${context.dateRange.date_to}:${envConfigured(env, ['OPENAI_ADMIN_KEY'])}:${envConfigured(env, ['OPENAI_PROJECT_ID'])}:${envDisabled(env, 'OPENAI_COSTS_ENABLED')}`,
        () => fetchOpenAIUsage(context)
      );
      diagnostics = live?.diagnostics || diagnostics;
    } catch (error) {
      liveError = error;
      diagnostics = error?.diagnostics || diagnostics;
    }
  }

  const liveConnected = Boolean(live?.usage);
  const problem = signals.missingReports >= 5;
  const warning = Boolean(liveError || signals.missingReports > 0 || (configured && !liveConnected));
  const usageSource = liveConnected ? 'Live OpenAI API' : 'alphaScreen report records';
  const usage = liveConnected ? [
    metric('Requests', live.usage.requests, 'Requests reported by the OpenAI organization usage endpoint for the selected date range.'),
    metric('Input tokens', live.usage.inputTokens, 'Text input tokens reported by OpenAI.'),
    metric('Output tokens', live.usage.outputTokens, 'Text output tokens reported by OpenAI.'),
    metric('Total tokens', live.usage.totalTokens, 'Input plus output tokens reported by OpenAI.'),
    metric('Models seen', live.usage.models.size, 'Number of model names returned by the OpenAI usage endpoint.'),
  ] : [
    metric('Reports generated', signals.reports.length, 'Reports created in alphaScreen during the selected date range.'),
    metric('Completed interview proxy', signals.completedInterviews.length, 'Completed interviews used as a proxy for possible scoring usage.'),
    metric('Last report event', signals.lastReportAt || 'Not available', 'Most recent report row in the selected date range.'),
  ];

  return {
    key: 'openai',
    name: 'OpenAI',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: usageSource,
    source_code: liveConnected ? 'live_vendor_api' : 'alphascreen_records',
    meaning: 'Shows AI scoring and report-generation usage.',
    health_summary: liveConnected
      ? 'Live OpenAI usage is connected.'
      : configured
        ? 'Using alphaScreen report records because live OpenAI usage is not connected.'
        : 'OpenAI credentials are not configured for this environment.',
    usage_summary: usage,
    problem_summary: [
      metric('Missing reports after completed interviews', signals.missingReports, 'Completed interviews without a report after the expected processing window.'),
      metric('Live API check', liveError ? 'Failed' : liveConnected ? 'Connected' : 'Not connected', 'Whether alphaScreen could read OpenAI organization usage for this date range.'),
    ],
    cost_summary: live?.cost
      ? costSummary({ value: live.cost.value, currency: live.cost.currency, sourceLabel: 'Live vendor API', help: live.cost.note || 'Cost reported by the OpenAI organization costs endpoint.' })
      : costSummary({ help: 'OpenAI live cost data is unavailable unless organization cost access is enabled.' }),
    diagnostics,
    readiness_items: [
      readiness('Credentials', configured ? 'Configured' : 'Missing', 'Required before alphaScreen can call OpenAI.'),
      readiness('Live usage API', liveConnected ? 'Connected' : 'Not connected', 'Requires OpenAI organization usage access.'),
      readiness('Record fallback', 'Available', 'alphaScreen report rows remain available when live usage is not connected.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'OpenAI live usage check failed.') : null,
    last_checked: now.toISOString(),
    notes: [
      ...(liveError ? ['OpenAI live usage could not be read; alphaScreen records are still shown.'] : []),
      ...(live?.cost?.note ? [live.cost.note] : []),
    ],
  };
}

module.exports = { buildOpenAIHealth };

const WebSocket = require('ws');
const {
  DEFAULT_VOICE,
  UPSTREAM_MAX_PAYLOAD,
  UPSTREAM_URL,
  attestSessionUpdated,
  buildAuthoritativeSessionUpdate,
  validatePreAttestationProviderEvent,
} = require('./supportVoiceProtocol');

const CANARY_PROMPT = 'alphaScreen support compatibility canary. Do not respond unless prompted.';
const FAILURE_CATEGORIES = new Set([
  'timeout', 'socket_error', 'provider_closed',
  'invalid_frame', 'unexpected_event', 'provider_attestation',
]);
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_STALE_MS = 25 * 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function boundedFailureCategory(value) {
  return FAILURE_CATEGORIES.has(value) ? value : 'unexpected_event';
}

function parseProviderFrame(raw, isBinary) {
  if (isBinary || !raw || !Number.isInteger(raw.length) || raw.length <= 0 || raw.length > UPSTREAM_MAX_PAYLOAD) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return null;
  }
}

function createSupportVoiceProviderCanary(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const WebSocketClient = options.WebSocketClient || WebSocket;
  const alert = typeof options.alert === 'function' ? options.alert : () => {};
  const now = options.now || Date.now;
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const staleMs = Number.isInteger(options.staleMs) && options.staleMs > intervalMs ? options.staleMs : DEFAULT_STALE_MS;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const state = {
    running: false,
    started: false,
    stopped: false,
    timer: null,
    cancelProbe: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureCategory: null,
    lastFailureField: null,
    consecutiveFailures: 0,
  };

  function configured() {
    return env.SUPPORT_VOICE_ENABLED === 'true' && typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim().length >= 20;
  }

  function ready() {
    if (!configured() || !state.lastSuccessAt) return false;
    const successAt = Date.parse(state.lastSuccessAt);
    return Number.isFinite(successAt) && now() - successAt <= staleMs && state.lastFailureCategory === null;
  }

  function snapshot() {
    return {
      provider_contract_ok: ready(),
      provider_last_attempt_at: state.lastAttemptAt,
      provider_last_success_at: state.lastSuccessAt,
      provider_last_failure_category: state.lastFailureCategory,
      provider_consecutive_failures: state.consecutiveFailures,
    };
  }

  function recordSuccess() {
    state.lastSuccessAt = new Date(now()).toISOString();
    state.lastFailureCategory = null;
    state.lastFailureField = null;
    state.consecutiveFailures = 0;
    try { logger.info?.('[support-voice] provider_contract_probe_ok'); } catch {}
  }

  function recordFailure(category, field = null) {
    state.lastFailureCategory = boundedFailureCategory(category);
    state.lastFailureField = typeof field === 'string' && field.length <= 64 ? field : null;
    state.consecutiveFailures += 1;
    try {
      logger.warn?.('[support-voice] provider_contract_probe_failed', {
        failure_category: state.lastFailureCategory,
        field: state.lastFailureField,
        consecutive_failures: Math.min(state.consecutiveFailures, 1_000_000),
        alert: state.consecutiveFailures >= 2,
      });
    } catch {}
    if (state.consecutiveFailures === 2) {
      try {
        alert({
          failure_category: state.lastFailureCategory,
          field: state.lastFailureField,
          consecutive_failures: state.consecutiveFailures,
        });
      } catch {}
    }
  }

  function probe() {
    if (state.stopped || !configured()) {
      return Promise.resolve(false);
    }
    if (state.running) return Promise.resolve(ready());
    state.running = true;
    state.lastAttemptAt = new Date(now()).toISOString();

    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      const settle = (ok, category = null, field = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        state.running = false;
        state.cancelProbe = null;
        const stopped = state.stopped;
        if (!stopped && ok) recordSuccess();
        else if (!stopped) recordFailure(category, field);
        try { socket?.close(1000, 'complete'); } catch {}
        try { socket?.terminate?.(); } catch {}
        resolve(ok && !stopped);
      };
      state.cancelProbe = () => settle(false, 'provider_closed');
      const timeout = setTimeout(() => settle(false, 'timeout'), timeoutMs);
      timeout.unref?.();
      try {
        socket = new WebSocketClient(UPSTREAM_URL, {
          headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
          maxPayload: UPSTREAM_MAX_PAYLOAD,
          perMessageDeflate: false,
          handshakeTimeout: Math.min(timeoutMs, 5_000),
        });
      } catch {
        return settle(false, 'socket_error');
      }
      socket.on('open', () => {
        try {
          socket.send(JSON.stringify(buildAuthoritativeSessionUpdate({ prompt: CANARY_PROMPT, voice: DEFAULT_VOICE })), (error) => {
            if (error) settle(false, 'socket_error');
          });
        } catch {
          settle(false, 'socket_error');
        }
      });
      socket.on('message', (raw, isBinary) => {
        const event = parseProviderFrame(raw, isBinary);
        if (!event) return settle(false, 'invalid_frame');
        if (validatePreAttestationProviderEvent(event)) return;
        if (event.type !== 'session.updated') return settle(false, 'unexpected_event');
        const attestation = attestSessionUpdated(event, { prompt: CANARY_PROMPT, voice: DEFAULT_VOICE });
        return attestation.ok
          ? settle(true)
          : settle(false, 'provider_attestation', attestation.field);
      });
      socket.on('error', () => settle(false, 'socket_error'));
      socket.on('close', (code) => {
        if (!settled) settle(false, code === 1000 ? 'unexpected_event' : 'provider_closed');
      });
    });
  }

  function schedule(delay = intervalMs) {
    if (state.stopped || !state.started) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void probe().finally(() => schedule(intervalMs));
    }, delay);
    state.timer.unref?.();
  }

  function start() {
    if (state.started || !configured()) return;
    state.started = true;
    state.stopped = false;
    schedule(0);
  }

  function stop() {
    state.stopped = true;
    clearTimeout(state.timer);
    state.timer = null;
    state.cancelProbe?.();
    state.cancelProbe = null;
    state.started = false;
  }

  return { probe, ready, snapshot, start, stop, _state: state };
}

module.exports = {
  CANARY_PROMPT,
  FAILURE_CATEGORIES,
  createSupportVoiceProviderCanary,
  parseProviderFrame,
};

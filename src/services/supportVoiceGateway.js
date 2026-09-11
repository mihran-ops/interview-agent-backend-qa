const crypto = require('node:crypto');
const express = require('express');
const net = require('node:net');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { hasAnyActiveClientMembership } = require('./supportVoiceMembership');
const { createSupportVoiceSessionStore } = require('./supportVoiceSessionStore');
const { buildSupportVoicePrompt, getSupportVoiceKnowledgeReadiness, SUPPORT_GREETING } = require('./supportVoiceKnowledge');
const { createSupportVoiceProviderCanary } = require('./supportVoiceProviderCanary');
const {
  BROWSER_MAX_PAYLOAD,
  DEFAULT_VOICE,
  UPSTREAM_MAX_PAYLOAD,
  UPSTREAM_URL,
  attestSessionUpdated,
  buildAuthoritativeSessionUpdate,
  classifyProviderEvent,
  exactKeys,
  validateBrowserEvent,
  validatePreAttestationProviderEvent,
} = require('./supportVoiceProtocol');

const PROTOCOL = 'alphascreen-support-v1';
const SESSION_PATH = '/api/support/voice';
const PENDING_TTL_MS = 60_000;
const MAX_SESSION_MS = 10 * 60_000;
const IDLE_MS = 120_000;
const PCM_BYTES_PER_MILLISECOND = 24_000 * 2 / 1000;
const MAX_PREAUTH = 50;
const ALL_FRAME_RATE = 40;
const ALL_FRAME_BURST = 80;
const AUDIO_FRAME_RATE = 25;
const AUDIO_FRAME_BURST = 50;
const AUDIO_BYTE_RATE = 256 * 1024;
const AUDIO_BYTE_BURST = 512 * 1024;
const INFLIGHT_MAX_FRAMES = 12;
const INFLIGHT_MAX_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_GRACE_MS = 10_000;
const UPSTREAM_CLOSE_GRACE_MS = 5_000;
const RATE_ACTIONS = new Set(['support_voice_session_create:user', 'support_voice_session_create:ip']);
const DIAGNOSTIC_PROVIDER_EVENTS = new Set([
  'session.created', 'conversation.created', 'ping', 'session.updated', 'response.created',
  'response.output_item.added', 'conversation.item.added', 'response.content_part.added',
  'response.output_audio.delta', 'response.audio.delta', 'response.output_audio_transcript.delta',
  'response.output_audio_transcript.done', 'response.content_part.done', 'response.output_audio.done',
  'response.output_item.done', 'response.done', 'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped', 'error',
]);
const FINAL_REASONS = new Set([
  'ended', 'idle_timeout', 'max_duration', 'shutdown', 'expired', 'response_failed',
  'protocol_error', 'support_voice_unavailable', 'client_disconnected',
]);
const CLIENT_CLOSE_REASONS = new Set([
  'user_end', 'popover_closed', 'signed_out', 'component_unmounted', 'server_ended', 'client_cancelled',
  'client_protocol_error', 'client_media_error', 'client_capture_backpressure', 'client_network_error', 'client_setup_error',
]);
const CLIENT_ERROR_CLOSE_REASONS = new Set([
  'client_protocol_error', 'client_media_error', 'client_capture_backpressure', 'client_network_error', 'client_setup_error',
]);
const SESSION_PHASES = new Set([
  'pending', 'consumed', 'upstream_connecting', 'session_update_sent', 'greeting_sent', 'ready', 'terminal',
]);

function base64url(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createTokenBucket(ratePerSecond, burst, now = Date.now()) {
  return { ratePerSecond, burst, tokens: burst, updatedAt: now };
}

function consumeToken(bucket, cost = 1, now = Date.now()) {
  if (!bucket || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(now)) return false;
  const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsedSeconds * bucket.ratePerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function parseJsonTextFrame(raw, maxBytes) {
  if (!raw || !Number.isInteger(raw.length) || raw.length <= 0 || raw.length > maxBytes) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseClientCloseReason(raw) {
  if (!(Buffer.isBuffer(raw) || raw instanceof Uint8Array) || raw.length <= 0 || raw.length > 64) return null;
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return CLIENT_CLOSE_REASONS.has(value) ? value : null;
  } catch {
    return null;
  }
}

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function configuredAllowedOrigins(env = process.env) {
  return [...new Set([
    String(env.SUPPORT_VOICE_ALLOWED_ORIGIN || '').trim(),
    ...String(env.SUPPORT_VOICE_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim()),
  ].filter(Boolean))];
}

function validExactOrigin(origin, env = process.env) {
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    if (env.NODE_ENV === 'production') return parsed.protocol === 'https:';
    if (parsed.protocol === 'https:') return true;
    return env.SUPPORT_VOICE_ALLOW_LOCAL_DEV === 'true' &&
      (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
  } catch {
    return false;
  }
}

function exactOrigin(req, env = process.env) {
  const origin = req.headers.origin;
  if (Array.isArray(origin) || typeof origin !== 'string' || !origin) return false;
  const allowed = new Set(configuredAllowedOrigins(env));
  if (env.NODE_ENV !== 'production' && env.SUPPORT_VOICE_ALLOW_LOCAL_DEV === 'true') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash && allowed.has(origin);
  } catch {
    return false;
  }
}

function validAllowedOrigin(env = process.env) {
  const configured = configuredAllowedOrigins(env);
  return configured.length > 0 && configured.every((origin) => validExactOrigin(origin, env));
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  noStore(res);
}

function rejectRequestBody(req, res, next) {
  const contentLength = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || (contentLength !== undefined && contentLength !== '0')) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  let sawByte = false;
  const onData = (chunk) => { if (chunk && chunk.length) sawByte = true; };
  req.on('data', onData);
  req.once('end', () => {
    req.removeListener('data', onData);
    if (sawByte) return res.status(400).json({ error: 'invalid_request' });
    next();
  });
}

function isPublicIp(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
      !/^fe[89ab]/.test(normalized) && !normalized.startsWith('ff') && !normalized.startsWith('2001:db8') && !normalized.startsWith('::ffff:');
  }
  return false;
}

function safeIp(req, mode) {
  const raw = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (isPublicIp(raw)) return raw;
  if (mode === 'best_effort') return null;
  throw new Error('SUPPORT_VOICE_IP_UNAVAILABLE');
}

function isConfigurationReady(env, knowledge, sessionStoreHealthy) {
  return env.SUPPORT_VOICE_ENABLED === 'true' &&
    (env.SUPPORT_VOICE_XFF_MODE === 'strict' || env.SUPPORT_VOICE_XFF_MODE === 'best_effort') &&
    (env.SUPPORT_VOICE_ALLOW_LOCAL_DEV !== 'true' || env.NODE_ENV !== 'production') &&
    validAllowedOrigin(env) &&
    typeof env.XAI_API_KEY === 'string' && env.XAI_API_KEY.trim().length >= 20 &&
    knowledge.ok === true && sessionStoreHealthy === true;
}

function createSupportVoiceGateway(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const serviceDb = options.serviceDb || require('../clients/supabase').supabaseAdmin;
  const requireAuth = options.requireAuth;
  if (typeof requireAuth !== 'function') throw new Error('SUPPORT_VOICE_REQUIRE_AUTH_REQUIRED');
  const rateLimit = options.rateLimit || require('./rateLimit').checkAndIncrementRateLimit;
  const WebSocketClient = options.WebSocketClient || WebSocket;
  const captureProviderAlert = typeof options.captureProviderAlert === 'function' ? options.captureProviderAlert : () => {};
  const sessionStore = options.sessionStore || createSupportVoiceSessionStore({ serviceDb });
  const providerCanary = options.providerCanary || (env.NODE_ENV === 'test'
    ? {
        ready: () => true,
        snapshot: () => ({
          provider_contract_ok: true,
          provider_last_attempt_at: null,
          provider_last_success_at: null,
          provider_last_failure_category: null,
          provider_consecutive_failures: 0,
        }),
        start() {},
        stop() {},
      }
    : createSupportVoiceProviderCanary({
        env,
        logger,
        WebSocketClient,
        alert: captureProviderAlert,
      }));
  const testDuration = (name, fallback) => env.NODE_ENV === 'test' && Number.isInteger(options[name]) && options[name] > 0 ? options[name] : fallback;
  const idleMs = testDuration('idleMs', IDLE_MS);
  const maxSessionMs = testDuration('maxSessionMs', MAX_SESSION_MS);
  const heartbeatIntervalMs = testDuration('heartbeatIntervalMs', HEARTBEAT_INTERVAL_MS);
  const heartbeatGraceMs = testDuration('heartbeatGraceMs', HEARTBEAT_GRACE_MS);
  const rateTimeoutMs = testDuration('rateTimeoutMs', 2000);
  const closeRetryBaseMs = testDuration('closeRetryBaseMs', 250);
  const router = express.Router();
  const sessions = new Map();
  const durableClosures = new Map();
  let preauthCount = 0;
  let attachedServer = null;

  function configuration() {
    const knowledge = getSupportVoiceKnowledgeReadiness();
    const sessionStoreHealthy = sessionStore.isHealthy();
    const configured = isConfigurationReady(env, knowledge, sessionStoreHealthy);
    return {
      knowledge,
      configured,
      ready: configured && providerCanary.ready(),
      sessionStoreHealthy,
    };
  }

  function publicHealth() {
    const config = configuration();
    return {
      enabled: env.SUPPORT_VOICE_ENABLED === 'true',
      configured: config.configured,
      available: config.ready,
      knowledge_ok: config.knowledge.ok === true,
      version: config.knowledge.version || null,
      sha256: config.knowledge.sha256 || null,
      xff_mode: ['strict', 'best_effort'].includes(env.SUPPORT_VOICE_XFF_MODE) ? env.SUPPORT_VOICE_XFF_MODE : null,
      session_store_ok: config.sessionStoreHealthy,
      ...providerCanary.snapshot(),
    };
  }

  function scheduleDurableClose(sessionId, reason, deadlineMs) {
    if (typeof sessionId !== 'string' || durableClosures.has(sessionId)) return;
    const safeReason = FINAL_REASONS.has(reason) ? reason : 'other';
    const deadline = Number.isFinite(deadlineMs) ? deadlineMs : Date.now() + MAX_SESSION_MS;
    const task = { attempt: 0, deadline, timer: null };
    durableClosures.set(sessionId, task);
    const run = async () => {
      try {
        const result = await sessionStore.close({ sessionId, reason: safeReason });
        if (result.status === 'missing' && Date.now() < task.deadline) {
          throw new Error('SUPPORT_VOICE_DURABLE_CLOSE_NOT_VISIBLE');
        }
        durableClosures.delete(sessionId);
      } catch {
        if (Date.now() >= task.deadline) {
          durableClosures.delete(sessionId);
          logger.warn?.('[support-voice] durable_close_expired', { reason: safeReason });
          return;
        }
        const delay = Math.min(5000, closeRetryBaseMs * (2 ** task.attempt));
        task.attempt += 1;
        task.timer = setTimeout(() => { void run(); }, delay);
        task.timer.unref?.();
      }
    };
    void run();
  }

  function createActiveEntry(row) {
    const expiresAt = Date.parse(row.expires_at);
    return {
      sessionId: row.session_id,
      phase: 'consumed',
      expiresAt,
      browser: null,
      upstream: null,
      timers: new Set(),
      speaking: false,
      responseEpoch: 0,
      responseActive: false,
      suppressedSpeechEvent: false,
      playbackEndsAt: 0,
      lastProviderEvent: null,
      providerFailureCategory: null,
      providerFailureField: null,
      browserToUpstream: { frames: 0, bytes: 0 },
      upstreamToBrowser: { frames: 0, bytes: 0 },
    };
  }

  function finalize(entry, reason = 'ended') {
    if (!entry || entry.phase === 'terminal') return;
    const phase = SESSION_PHASES.has(entry.phase) ? entry.phase : 'other';
    const safeReason = FINAL_REASONS.has(reason) ? reason : 'other';
    const lastProviderEvent = DIAGNOSTIC_PROVIDER_EVENTS.has(entry.lastProviderEvent) ? entry.lastProviderEvent : null;
    entry.phase = 'terminal';
    if (safeReason === 'support_voice_unavailable' || safeReason === 'protocol_error') {
      const metadata = {
        reason: safeReason,
        phase,
        last_provider_event: lastProviderEvent,
      };
      if (typeof entry.providerFailureCategory === 'string') metadata.failure_category = entry.providerFailureCategory;
      if (typeof entry.providerFailureField === 'string') metadata.field = entry.providerFailureField;
      logger.warn?.('[support-voice] session_finalized', metadata);
    }
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
    if (entry.sessionId) sessions.delete(entry.sessionId);
    scheduleDurableClose(entry.sessionId, safeReason, entry.expiresAt);
    const upstream = entry.upstream;
    try {
      if (entry.browser && entry.browser.readyState === WebSocket.OPEN) {
        const message = ['ended', 'idle_timeout', 'max_duration'].includes(reason)
          ? { type: 'ended', reason }
          : { type: 'error', code: 'support_voice_unavailable' };
        entry.browser.send(JSON.stringify(message));
      }
    } catch {}
    try { entry.browser?.close(1000, 'ended'); } catch {}
    try {
      upstream?.close();
      if (upstream && typeof upstream.terminate === 'function') {
        const terminateTimer = setTimeout(() => { try { upstream.terminate(); } catch {} }, UPSTREAM_CLOSE_GRACE_MS);
        terminateTimer.unref?.();
        upstream.once?.('close', () => clearTimeout(terminateTimer));
      }
    } catch {}
    if (entry.browserToUpstream) {
      entry.browserToUpstream.frames = 0;
      entry.browserToUpstream.bytes = 0;
    }
    if (entry.upstreamToBrowser) {
      entry.upstreamToBrowser.frames = 0;
      entry.upstreamToBrowser.bytes = 0;
    }
    entry.browser = null;
    entry.upstream = null;
  }

  function finalizeAll(reason = 'shutdown') {
    for (const entry of [...sessions.values()]) finalize(entry, reason);
  }

  async function increment(action, subject, windowMs, maxCount) {
    if (!RATE_ACTIONS.has(action)) throw new Error('SUPPORT_VOICE_RATE_ACTION_INVALID');
    const result = await Promise.race([
      rateLimit({ routeName: action, subjectKey: digest(subject), windowMs, maxCount }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SUPPORT_VOICE_RATE_TIMEOUT')), rateTimeoutMs)),
    ]);
    if (!result || typeof result !== 'object' || typeof result.allowed !== 'boolean') throw new Error('SUPPORT_VOICE_RATE_RESULT_INVALID');
    return result.allowed;
  }

  router.use((req, res, next) => {
    noStore(res);
    if (!exactOrigin(req, env)) return res.status(403).json({ error: 'support_voice_unavailable' });
    setCors(req, res);
    next();
  });

  router.options(['/sessions', '/sessions/pending'], (req, res) => {
    const requestedMethod = String(req.headers['access-control-request-method'] || '');
    const requestedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
    if (!['POST', 'DELETE'].includes(requestedMethod) || requestedHeaders.some((value) => value !== 'authorization')) return res.status(403).end();
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    return res.status(204).end();
  });

  router.post('/sessions', rejectRequestBody, requireAuth, async (req, res) => {
    const rawUserId = req.user?.id;
    const isAdmin = req.isGlobalAdmin === true;
    let sessionId = null;
    let reserveDeadline = 0;
    delete req.userToken;
    if (req.user) req.user.email = null;
    if (typeof rawUserId !== 'string' || !rawUserId) return res.status(401).json({ error: 'support_voice_unauthorized' });
    const userHash = digest(rawUserId);
    try {
      const member = isAdmin || await hasAnyActiveClientMembership({ serviceDb, userId: rawUserId });
      if (!member) return res.status(403).json({ error: 'support_voice_forbidden' });
      const config = configuration();
      if (!config.ready) return res.status(503).json({ error: 'support_voice_unavailable' });
      if (!await increment('support_voice_session_create:user', userHash, 15 * 60_000, 5)) return res.status(429).json({ error: 'support_voice_rate_limited' });
      const ip = safeIp(req, env.SUPPORT_VOICE_XFF_MODE);
      if (ip && !await increment('support_voice_session_create:ip', ip, 15 * 60_000, 20)) return res.status(429).json({ error: 'support_voice_rate_limited' });
      sessionId = base64url(16);
      reserveDeadline = Date.now() + PENDING_TTL_MS;
      const credential = `${sessionId}.${base64url(32)}`;
      const reserved = await sessionStore.reserve({
        sessionId,
        credentialDigest: digest(credential),
        userFingerprint: userHash,
      });
      if (reserved.status === 'conflict') return res.status(409).json({ error: 'support_voice_already_open' });
      if (reserved.status !== 'created') return res.status(503).json({ error: 'support_voice_unavailable' });
      const expiresAt = Date.parse(reserved.expires_at);
      const onClose = () => {
        if (!res.writableFinished) scheduleDurableClose(sessionId, 'response_failed', expiresAt);
      };
      res.once('close', onClose);
      res.once('error', onClose);
      return res.status(201).json({
        session_id: sessionId,
        credential,
        expires_at: reserved.expires_at,
      });
    } catch (_error) {
      if (sessionId) scheduleDurableClose(sessionId, 'response_failed', reserveDeadline);
      return res.status(503).json({ error: 'support_voice_unavailable' });
    }
  });

  router.delete('/sessions/pending', rejectRequestBody, requireAuth, async (req, res) => {
    const rawUserId = req.user?.id;
    delete req.userToken;
    if (req.user) req.user.email = null;
    if (typeof rawUserId === 'string' && rawUserId) {
      try {
        await sessionStore.closePending({ userFingerprint: digest(rawUserId), reason: 'abandoned' });
      } catch {}
    }
    return res.status(204).end();
  });

  router.get('/health', (_req, res) => {
    return res.json(publicHealth());
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: BROWSER_MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols(protocols) { return protocols.size === 1 && protocols.has(PROTOCOL) ? PROTOCOL : false; },
  });

  async function consumeCredential(credential) {
    if (typeof credential !== 'string') return null;
    const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(credential);
    if (!match) return null;
    const sessionId = match[1];
    let consumed;
    try {
      consumed = await sessionStore.consume({ credentialDigest: digest(credential) });
    } catch (error) {
      scheduleDurableClose(sessionId, 'response_failed', Date.now() + PENDING_TTL_MS);
      throw error;
    }
    if (consumed.status !== 'consumed') return null;
    if (consumed.session_id !== sessionId) {
      scheduleDurableClose(sessionId, 'protocol_error', Date.now() + PENDING_TTL_MS);
      scheduleDurableClose(consumed.session_id, 'protocol_error', Date.parse(consumed.expires_at));
      return null;
    }
    const entry = createActiveEntry(consumed);
    sessions.set(entry.sessionId, entry);
    return entry;
  }

  function guardedSend(entry, direction, socket, encoded, maxPayload) {
    const bytes = Buffer.byteLength(encoded);
    const counters = entry?.[direction];
    if (!counters || socket?.readyState !== WebSocket.OPEN || bytes <= 0 || bytes > maxPayload ||
        counters.frames + 1 > INFLIGHT_MAX_FRAMES || counters.bytes + bytes > INFLIGHT_MAX_BYTES ||
        socket.bufferedAmount > INFLIGHT_MAX_BYTES) return false;
    counters.frames += 1;
    counters.bytes += bytes;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      counters.frames = Math.max(0, counters.frames - 1);
      counters.bytes = Math.max(0, counters.bytes - bytes);
      if (error) finalize(entry, 'support_voice_unavailable');
    };
    try { socket.send(encoded, settle); } catch (error) { settle(error); return false; }
    return true;
  }

  function sendBrowser(entry, message) {
    return guardedSend(entry, 'upstreamToBrowser', entry.browser, JSON.stringify(message), UPSTREAM_MAX_PAYLOAD);
  }

  function sendUpstream(entry, message) {
    return guardedSend(entry, 'browserToUpstream', entry.upstream, JSON.stringify(message), BROWSER_MAX_PAYLOAD);
  }

  function clearEntryTimer(entry, key) {
    const timer = entry[key];
    if (!timer) return;
    clearTimeout(timer);
    entry.timers.delete(timer);
    entry[key] = null;
  }

  function resetIdle(entry, delayMs = idleMs) {
    clearEntryTimer(entry, 'idleTimer');
    const safeDelayMs = Number.isFinite(delayMs) && delayMs >= idleMs ? Math.ceil(delayMs) : idleMs;
    const timer = setTimeout(() => {
      finalize(entry, 'idle_timeout');
    }, safeDelayMs);
    timer.unref?.();
    entry.idleTimer = timer;
    entry.timers.add(timer);
  }

  function startHeartbeat(entry) {
    const schedulePing = () => {
      if (entry.phase === 'terminal') return;
      const timer = setTimeout(() => {
        entry.timers.delete(timer);
        entry.heartbeatTimer = null;
        if (entry.phase === 'terminal' || entry.browser?.readyState !== WebSocket.OPEN) return finalize(entry, 'support_voice_unavailable');
        entry.awaitingPong = true;
        try { entry.browser.ping(); } catch { return finalize(entry, 'support_voice_unavailable'); }
        const deadline = setTimeout(() => {
          entry.timers.delete(deadline);
          entry.heartbeatDeadline = null;
          if (entry.awaitingPong) finalize(entry, 'support_voice_unavailable');
        }, heartbeatGraceMs);
        deadline.unref?.();
        entry.heartbeatDeadline = deadline;
        entry.timers.add(deadline);
      }, heartbeatIntervalMs);
      timer.unref?.();
      entry.heartbeatTimer = timer;
      entry.timers.add(timer);
    };
    entry.browser.on('pong', () => {
      if (!entry.awaitingPong || entry.phase === 'terminal') return;
      entry.awaitingPong = false;
      clearEntryTimer(entry, 'heartbeatDeadline');
      schedulePing();
    });
    schedulePing();
  }

  function connectUpstream(entry) {
    const built = buildSupportVoicePrompt();
    entry.phase = 'upstream_connecting';
    const upstream = new WebSocketClient(UPSTREAM_URL, {
      headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
      maxPayload: UPSTREAM_MAX_PAYLOAD,
      perMessageDeflate: false,
      handshakeTimeout: 5000,
    });
    entry.upstream = upstream;
    const setup = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 5000);
    setup.unref?.();
    entry.timers.add(setup);
    upstream.on('open', () => {
      if (entry.phase !== 'upstream_connecting') return finalize(entry, 'support_voice_unavailable');
      clearTimeout(setup);
      entry.timers.delete(setup);
      entry.phase = 'session_update_sent';
      upstream.send(JSON.stringify(buildAuthoritativeSessionUpdate({ prompt: built.prompt, voice: DEFAULT_VOICE })), (error) => {
        if (error) finalize(entry, 'support_voice_unavailable');
      });
      const ack = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 5000);
      ack.unref?.();
      entry.timers.add(ack);
      entry.ackTimer = ack;
    });
    upstream.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > UPSTREAM_MAX_PAYLOAD) return finalize(entry, 'support_voice_unavailable');
      const event = parseJsonTextFrame(raw, UPSTREAM_MAX_PAYLOAD);
      if (!event) return finalize(entry, 'support_voice_unavailable');
      entry.lastProviderEvent = DIAGNOSTIC_PROVIDER_EVENTS.has(event.type) ? event.type : null;
      if (validatePreAttestationProviderEvent(event)) {
        if (entry.phase === 'session_update_sent' ||
            (event.type === 'ping' && (entry.phase === 'greeting_sent' || entry.phase === 'ready'))) return;
        return finalize(entry, 'support_voice_unavailable');
      }
      if (event.type === 'session.updated') {
        const attestation = attestSessionUpdated(event, { prompt: built.prompt, voice: DEFAULT_VOICE });
        if (entry.phase !== 'session_update_sent' || !attestation.ok) {
          entry.providerFailureCategory = entry.phase === 'session_update_sent' ? 'provider_attestation' : 'unexpected_phase';
          entry.providerFailureField = attestation.ok ? null : attestation.field;
          return finalize(entry, 'support_voice_unavailable');
        }
        clearTimeout(entry.ackTimer);
        entry.timers.delete(entry.ackTimer);
        entry.phase = 'greeting_sent';
        const greetingTimer = setTimeout(() => finalize(entry, 'support_voice_unavailable'), 2000);
        greetingTimer.unref?.();
        entry.timers.add(greetingTimer);
        try {
          upstream.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'force_message', role: 'assistant', interruptible: true, content: [{ type: 'output_text', text: SUPPORT_GREETING }] } }), (error) => {
            clearTimeout(greetingTimer);
            entry.timers.delete(greetingTimer);
            if (error) finalize(entry, 'support_voice_unavailable');
          });
        } catch {
          clearTimeout(greetingTimer);
          entry.timers.delete(greetingTimer);
          return finalize(entry, 'support_voice_unavailable');
        }
        if (entry.phase === 'terminal') return;
        entry.phase = 'ready';
        if (!sendBrowser(entry, { type: 'ready' })) return finalize(entry, 'support_voice_unavailable');
        resetIdle(entry);
        return;
      }
      if (entry.phase !== 'ready') return finalize(entry, 'support_voice_unavailable');
      const classified = classifyProviderEvent(event);
      if (classified.action === 'finalize') return finalize(entry, 'support_voice_unavailable');
      if (event.type === 'response.created') {
        if (entry.responseActive) return finalize(entry, 'support_voice_unavailable');
        clearEntryTimer(entry, 'idleTimer');
        entry.responseEpoch += 1;
        entry.responseActive = true;
        entry.suppressedSpeechEvent = false;
        entry.playbackEndsAt = Date.now();
        entry.speaking = true;
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        if (entry.responseActive) {
          entry.suppressedSpeechEvent = true;
          return;
        }
        entry.speaking = false;
      }
      if (event.type === 'input_audio_buffer.speech_stopped' && entry.suppressedSpeechEvent) {
        entry.suppressedSpeechEvent = false;
        return;
      }
      if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') &&
          (!entry.responseActive || !entry.speaking)) return;
      if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') &&
          Number.isSafeInteger(classified.audioBytes) && classified.audioBytes > 0) {
        entry.playbackEndsAt = Math.max(Date.now(), entry.playbackEndsAt) + classified.audioBytes / PCM_BYTES_PER_MILLISECOND;
      }
      if (event.type === 'response.done') {
        if (!entry.responseActive) return;
        entry.responseActive = false;
        entry.speaking = false;
        entry.suppressedSpeechEvent = false;
        const audiblePlaybackRemainingMs = Math.max(0, entry.playbackEndsAt - Date.now());
        resetIdle(entry, audiblePlaybackRemainingMs + idleMs);
      }
      if (event.type === 'input_audio_buffer.speech_started') resetIdle(entry);
      if (classified.action === 'forward' && !sendBrowser(entry, classified.message)) return finalize(entry, 'support_voice_unavailable');
      if (classified.action === 'forward_many' && classified.messages.some((message) => !sendBrowser(entry, message))) return finalize(entry, 'support_voice_unavailable');
    });
    upstream.on('error', () => finalize(entry, 'support_voice_unavailable'));
    upstream.on('close', (code, rawReason) => {
      if (entry.phase === 'terminal') return;
      const closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null;
      const reasonPresent = (Buffer.isBuffer(rawReason) || rawReason instanceof Uint8Array) && rawReason.length > 0;
      logger.warn?.('[support-voice] provider_session_closed', {
        close_code: closeCode,
        reason_present: reasonPresent,
        phase: SESSION_PHASES.has(entry.phase) ? entry.phase : 'other',
        during_response: entry.responseActive === true,
        last_provider_event: DIAGNOSTIC_PROVIDER_EVENTS.has(entry.lastProviderEvent) ? entry.lastProviderEvent : null,
      });
      finalize(entry, closeCode === 1000 && !entry.responseActive ? 'ended' : 'support_voice_unavailable');
    });
  }

  wss.on('connection', (socket) => {
    preauthCount += 1;
    let entry = null;
    let authState = 'awaiting_first';
    let preauthReleased = false;
    const allFrames = createTokenBucket(ALL_FRAME_RATE, ALL_FRAME_BURST);
    const releasePreauth = () => {
      if (preauthReleased) return;
      preauthReleased = true;
      preauthCount = Math.max(0, preauthCount - 1);
    };
    const authTimer = setTimeout(() => { try { socket.close(1008, 'unauthorized'); } catch {} }, 5000);
    authTimer.unref?.();
    socket.on('message', async (raw, isBinary) => {
      if (authState === 'consuming') return socket.close(1008, 'unauthorized');
      if (authState === 'awaiting_first') {
        authState = 'consuming';
        clearTimeout(authTimer);
        releasePreauth();
        if (!consumeToken(allFrames) || isBinary || raw.length > 1024) return socket.close(1008, 'unauthorized');
        const auth = parseJsonTextFrame(raw, 1024);
        if (!auth || !exactKeys(auth, ['type', 'credential']) || auth.type !== 'authenticate') return socket.close(1008, 'unauthorized');
        try {
          entry = await consumeCredential(auth.credential);
        } catch {
          entry = null;
        } finally {
          auth.credential = null;
        }
        if (!entry) return socket.close(1008, 'unauthorized');
        if (socket.readyState !== WebSocket.OPEN) return finalize(entry, 'client_disconnected');
        authState = 'authenticated';
        entry.browser = socket;
        entry.allFrames = allFrames;
        entry.audioFrames = createTokenBucket(AUDIO_FRAME_RATE, AUDIO_FRAME_BURST);
        entry.audioBytes = createTokenBucket(AUDIO_BYTE_RATE, AUDIO_BYTE_BURST);
        const maximumDelay = Math.max(1, Math.min(maxSessionMs, entry.expiresAt - Date.now()));
        const maximum = setTimeout(() => finalize(entry, 'max_duration'), maximumDelay);
        maximum.unref?.();
        entry.timers.add(maximum);
        startHeartbeat(entry);
        try { connectUpstream(entry); } catch { finalize(entry, 'support_voice_unavailable'); }
        return;
      }

      if (!entry || !consumeToken(entry.allFrames) || isBinary || raw.length > BROWSER_MAX_PAYLOAD || entry.phase !== 'ready') return finalize(entry, 'protocol_error');
      const event = parseJsonTextFrame(raw, BROWSER_MAX_PAYLOAD);
      if (!event) return finalize(entry, 'protocol_error');
      const validated = validateBrowserEvent(event);
      if (!validated || entry.upstream?.readyState !== WebSocket.OPEN) return finalize(entry, 'protocol_error');
      if (validated.type === 'input_audio_buffer.append') {
        const audioBytes = Buffer.from(validated.audio, 'base64').length;
        if (!consumeToken(entry.audioFrames) || !consumeToken(entry.audioBytes, audioBytes)) return finalize(entry, 'protocol_error');
        if (entry.responseActive) return;
      }
      if (!sendUpstream(entry, validated)) return finalize(entry, 'support_voice_unavailable');
    });
    socket.on('close', (_code, rawReason) => {
      clearTimeout(authTimer);
      if (authState !== 'authenticated') releasePreauth();
      const clientReason = parseClientCloseReason(rawReason);
      if (clientReason && CLIENT_ERROR_CLOSE_REASONS.has(clientReason)) {
        logger.warn?.('[support-voice] client_session_closed', { reason: clientReason });
      }
      if (entry) finalize(entry, 'ended');
    });
    socket.on('error', () => {
      clearTimeout(authTimer);
      if (authState !== 'authenticated') releasePreauth();
      if (entry) finalize(entry, 'support_voice_unavailable');
    });
  });

  function attach(server) {
    if (attachedServer === server) return;
    if (attachedServer) throw new Error('SUPPORT_VOICE_ALREADY_ATTACHED');
    attachedServer = server;
    sessionStore.start();
    providerCanary.start();
    server.on('upgrade', (req, socket, head) => {
      let path;
      try { path = new URL(req.url, 'http://localhost').pathname; } catch { return socket.destroy(); }
      if (path !== SESSION_PATH || !configuration().ready || !exactOrigin(req, env)) return socket.destroy();
      const protocol = req.headers['sec-websocket-protocol'];
      if (typeof protocol !== 'string' || protocol !== PROTOCOL || preauthCount >= MAX_PREAUTH) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (websocket) => wss.emit('connection', websocket, req));
    });
  }

  return {
    attach,
    finalizeAll: () => {
      finalizeAll('shutdown');
      providerCanary.stop();
      sessionStore.stop();
    },
    health: configuration,
    publicHealth,
    router,
    setSessionStoreHealthyForTest(value) {
      if (env.NODE_ENV !== 'test' || typeof sessionStore?._state?.setHealthyForTest !== 'function') throw new Error('SUPPORT_VOICE_TEST_ONLY');
      sessionStore._state.setHealthyForTest(value);
    },
    _state: { durableClosures, providerCanary, sessions, sessionStore, wss },
  };
}

module.exports = {
  ALL_FRAME_BURST,
  ALL_FRAME_RATE,
  AUDIO_BYTE_BURST,
  AUDIO_BYTE_RATE,
  AUDIO_FRAME_BURST,
  AUDIO_FRAME_RATE,
  BROWSER_MAX_PAYLOAD,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  IDLE_MS,
  INFLIGHT_MAX_BYTES,
  INFLIGHT_MAX_FRAMES,
  MAX_PREAUTH,
  PROTOCOL,
  RATE_ACTIONS,
  SESSION_PATH,
  consumeToken,
  configuredAllowedOrigins,
  createTokenBucket,
  createSupportVoiceGateway,
  exactOrigin,
  isConfigurationReady,
  isPublicIp,
  rejectRequestBody,
  safeIp,
  validAllowedOrigin,
};

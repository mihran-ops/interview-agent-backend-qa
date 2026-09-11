const DEFAULT_RPC_TIMEOUT_MS = 2000;
const DEFAULT_HEALTH_INTERVAL_MS = 2000;
const DEFAULT_HEALTH_FRESHNESS_MS = 5000;

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data && typeof data === 'object' ? data : null;
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function createSupportVoiceSessionStore(options = {}) {
  const serviceDb = options.serviceDb;
  if (!serviceDb || typeof serviceDb.rpc !== 'function') throw new Error('SUPPORT_VOICE_SESSION_STORE_DB_REQUIRED');
  const now = options.now || Date.now;
  const rpcTimeoutMs = Number.isInteger(options.rpcTimeoutMs) && options.rpcTimeoutMs > 0
    ? options.rpcTimeoutMs
    : DEFAULT_RPC_TIMEOUT_MS;
  const healthIntervalMs = Number.isInteger(options.healthIntervalMs) && options.healthIntervalMs > 0
    ? options.healthIntervalMs
    : DEFAULT_HEALTH_INTERVAL_MS;
  const healthFreshnessMs = Number.isInteger(options.healthFreshnessMs) && options.healthFreshnessMs > 0
    ? options.healthFreshnessMs
    : DEFAULT_HEALTH_FRESHNESS_MS;
  let healthOk = options.initialHealthy === true;
  let healthCheckedAt = healthOk ? now() : 0;
  let healthTimer = null;

  function setUnhealthy() {
    healthOk = false;
    healthCheckedAt = 0;
  }

  async function rpc(name, args) {
    let timeout;
    try {
      return await Promise.race([
        serviceDb.rpc(name, args),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('SUPPORT_VOICE_SESSION_STORE_TIMEOUT')), rpcTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function probe() {
    try {
      const result = await rpc('service_support_voice_session_health');
      if (result?.error || result?.data !== true) throw new Error('SUPPORT_VOICE_SESSION_STORE_HEALTH');
      healthOk = true;
      healthCheckedAt = now();
      return true;
    } catch {
      setUnhealthy();
      return false;
    }
  }

  function isHealthy() {
    return healthOk && now() - healthCheckedAt <= healthFreshnessMs;
  }

  function start() {
    if (healthTimer) return;
    void probe();
    healthTimer = setInterval(() => { void probe(); }, healthIntervalMs);
    healthTimer.unref?.();
  }

  function stop() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    setUnhealthy();
  }

  async function reserve({ sessionId, credentialDigest, userFingerprint }) {
    try {
      const result = await rpc('service_reserve_support_voice_session', {
        p_session_id: sessionId,
        p_credential_digest_hex: credentialDigest,
        p_user_fingerprint: userFingerprint,
      });
      const row = firstRow(result?.data);
      if (result?.error || !row || !['created', 'conflict', 'capacity'].includes(row.status)) throw new Error('SUPPORT_VOICE_SESSION_STORE_RESERVE');
      if (row.status === 'created' && (row.session_id !== sessionId || !validIso(row.expires_at))) throw new Error('SUPPORT_VOICE_SESSION_STORE_RESERVE');
      return row;
    } catch (error) {
      setUnhealthy();
      throw error;
    }
  }

  async function consume({ credentialDigest }) {
    try {
      const result = await rpc('service_consume_support_voice_session', {
        p_credential_digest_hex: credentialDigest,
      });
      const row = firstRow(result?.data);
      if (result?.error || !row || !['consumed', 'invalid', 'expired'].includes(row.status)) throw new Error('SUPPORT_VOICE_SESSION_STORE_CONSUME');
      if (row.status === 'consumed' && (
        typeof row.session_id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(row.session_id) ||
        typeof row.user_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.user_fingerprint) ||
        !validIso(row.expires_at)
      )) throw new Error('SUPPORT_VOICE_SESSION_STORE_CONSUME');
      return row;
    } catch (error) {
      setUnhealthy();
      throw error;
    }
  }

  async function close({ sessionId, reason }) {
    const result = await rpc('service_close_support_voice_session', {
      p_session_id: sessionId,
      p_reason: reason,
    });
    const row = firstRow(result?.data);
    if (result?.error || !row || !['closed', 'missing'].includes(row.status)) throw new Error('SUPPORT_VOICE_SESSION_STORE_CLOSE');
    return row;
  }

  async function closePending({ userFingerprint, reason = 'abandoned' }) {
    const result = await rpc('service_close_pending_support_voice_sessions', {
      p_user_fingerprint: userFingerprint,
      p_reason: reason,
    });
    if (result?.error || !Number.isInteger(result?.data) || result.data < 0) throw new Error('SUPPORT_VOICE_SESSION_STORE_CLOSE_PENDING');
    return result.data;
  }

  return {
    close,
    closePending,
    consume,
    isHealthy,
    probe,
    reserve,
    start,
    stop,
    _state: {
      get healthCheckedAt() { return healthCheckedAt; },
      setHealthyForTest(value) {
        if (options.allowTestControl !== true) throw new Error('SUPPORT_VOICE_TEST_ONLY');
        healthOk = value === true;
        healthCheckedAt = healthOk ? now() : 0;
      },
    },
  };
}

module.exports = {
  DEFAULT_HEALTH_FRESHNESS_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  createSupportVoiceSessionStore,
};

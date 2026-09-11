const crypto = require('crypto');
const { supabaseAdmin } = require('../clients/supabase');

function getRequestSubjectKey(req) {
  // Express derives req.ip from trusted proxies configured by the application.
  // Reading x-forwarded-for here would let direct clients choose another subject.
  return String(req?.ip || req?.socket?.remoteAddress || 'unknown').trim() || 'unknown';
}

function hashRateLimitSubject(...parts) {
  const normalized = parts
    .map((part) => String(part || '').trim().toLowerCase())
    .join('\u001f');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function checkAndIncrementRateLimit({
  routeName,
  subjectKey,
  windowMs,
  maxCount
}) {
  const route = String(routeName || '').trim();
  const subject = String(subjectKey || '').trim() || 'unknown';
  const windowSizeMs = Number(windowMs) > 0 ? Number(windowMs) : 0;
  const max = Number(maxCount) > 0 ? Number(maxCount) : 0;
  const { data, error } = await supabaseAdmin.rpc('check_and_increment_rate_limit', {
    p_route_name: route,
    p_subject_key: subject,
    p_window_ms: windowSizeMs,
    p_max_count: max
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error('RATE_LIMIT_RPC_EMPTY_RESULT');
  }

  return {
    allowed: Boolean(row.allowed),
    count: Number(row.count || 0),
    remaining: Number(row.remaining || 0),
    retryAfterSeconds: Number(row.retry_after_seconds || 0)
  };
}

module.exports = {
  getRequestSubjectKey,
  hashRateLimitSubject,
  checkAndIncrementRateLimit
};

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../clients/supabase');
const { buildPublicPwResetUrl } = require('../config/urlConfig');

const redactEmail = (email) => {
  try {
    if (!email) return '';
    const [user, domain] = String(email).split('@');
    if (!domain) return email;
    if (user.length <= 3) return `${user[0] || ''}***@${domain}`;
    return `${user.slice(0, 2)}***@${domain}`;
  } catch (_) {
    return email;
  }
};

async function ensureUserAndSendRecovery({ email, redirectTo, request_id, loggerPrefix = '[recover-helper]' }) {
  const requestId = request_id || crypto.randomUUID?.() || String(Date.now());
  const effectiveRedirect = redirectTo || buildPublicPwResetUrl();
  const normalizedEmail = String(email || '').trim();
  const emailLower = normalizedEmail.toLowerCase();
  const safeEmail = redactEmail(email);

  let userId = null;
  let actionLink = null;
  let method = null;
  let lastErr = null;

  const findUserId = async () => {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email: normalizedEmail });
      if (error) {
        console.error(`${loggerPrefix} listUsers failed`, { request_id: requestId, email: safeEmail, error: error.message, code: error.code });
      }
      const existing = (data?.users || []).find((u) => String(u?.email || '').trim().toLowerCase() === emailLower);
      return existing?.id || null;
    } catch (e) {
      console.error(`${loggerPrefix} listUsers exception`, { request_id: requestId, email: safeEmail, error: e?.message || e });
      return null;
    }
  };

  const generateRecoveryLink = async () => {
    const link = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo: effectiveRedirect }
    });
    return {
      userId: link?.data?.user?.id || null,
      actionLink: link?.data?.action_link || link?.data?.properties?.action_link || null
    };
  };

  try {
    const generated = await generateRecoveryLink();
    userId = generated.userId || userId;
    actionLink = generated.actionLink || actionLink;
    method = 'recovery';
  } catch (e) {
    lastErr = e;
    console.error(`${loggerPrefix} generateLink(recovery) failed`, { request_id: requestId, email: safeEmail, error: e?.message || e });
  }

  if (!userId) {
    userId = await findUserId();
    if (userId && !method) method = 'existingUser';
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({ email: normalizedEmail, email_confirm: true });
      userId = created?.data?.user?.id || null;
      method = 'createUser';
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      if (!msg.includes('already') && !msg.includes('exists')) {
        console.error(`${loggerPrefix} createUser failed`, { request_id: requestId, email: safeEmail, error: e?.message || e, code: e?.code });
        const err = new Error('create_user_failed');
        err.code = 'create_user_failed';
        err.detail = e?.message || e;
        err.request_id = requestId;
        err.status = e?.status || e?.response?.status || null;
        throw err;
      }
      userId = await findUserId();
    }
  }

  if (!actionLink) {
    try {
      const retry = await generateRecoveryLink();
      userId = retry.userId || userId;
      actionLink = retry.actionLink || actionLink;
      method = userId ? 'recovery_retry' : method;
    } catch (e) {
      lastErr = e;
      console.error(`${loggerPrefix} generateLink(recovery) retry failed`, { request_id: requestId, email: safeEmail, error: e?.message || e });
    }
  }

  if (!userId) {
    const err = new Error('add_member_no_user_id');
    err.code = 'add_member_no_user_id';
    err.detail = 'Could not create or locate user for this email.';
    err.request_id = requestId;
    err.status = lastErr?.status || lastErr?.response?.status || null;
    throw err;
  }

  if (!actionLink) {
    const err = new Error('recover_failed');
    err.code = 'recover_failed';
    err.status = lastErr?.status || lastErr?.response?.status || null;
    err.request_id = requestId;
    err.detail = lastErr?.message || 'Recovery link generation failed';
    throw err;
  }

  return { userId, method, actionLink, recovery_sent: true, request_id: requestId };
}

module.exports = { ensureUserAndSendRecovery, redactEmail };

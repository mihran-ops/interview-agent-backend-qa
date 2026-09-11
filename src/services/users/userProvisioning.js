'use strict';

// Supabase Auth user provisioning, moved out of app.js unchanged. Shared by the admin
// routes and the public checkout-success handler, so it belongs to neither router.

const { supabaseAdmin } = require('../../clients/supabase');

// Helper: ensure a user exists/invite; return user_id + optional action_link
async function ensureUserIdAndInvite(email, redirectTo, opts = {}) {
  const suppressInvite = opts?.suppressInvite === true
  let userId = null
  let actionLink = null
  let method = null

  if (!suppressInvite) {
    try {
      const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
      userId = invited?.data?.user?.id || null
      method = 'invite'
    } catch (e) {
      console.error('inviteUserByEmail failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo }
      })
      userId = link?.data?.user?.id || null
      actionLink = link?.data?.action_link || null
      method = method || 'magiclink'
    } catch (e) {
      console.error('generateLink(magiclink) failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true
      })
      userId = created?.data?.user?.id || null
      method = method || 'createUser'
    } catch (e) {
      console.error('createUser failed:', e?.message || e)
    }
    if (userId && !suppressInvite) {
      try {
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
        method = 'createUser+invite'
      } catch (e) {
        console.error('second invite after createUser failed:', e?.message || e)
      }
    }
  }

  return { userId, actionLink, method }
}

async function ensureUserIdAndRecoveryLink(email, redirectTo, opts = {}) {
  const requireActionLink = opts?.requireActionLink === true
  const normalizedEmail = String(email || '').trim()
  const emailLower = normalizedEmail.toLowerCase()

  let userId = null
  let actionLink = null
  let method = null
  let lastErr = null

  const findUserId = async () => {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email: normalizedEmail })
      if (error) {
        console.error('listUsers(recovery) failed:', error?.message || error)
        return null
      }
      const existing = (data?.users || []).find((u) => String(u?.email || '').trim().toLowerCase() === emailLower)
      return existing?.id || null
    } catch (e) {
      console.error('listUsers(recovery) exception:', e?.message || e)
      return null
    }
  }

  const generateRecoveryLink = async () => {
    const link = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo }
    })
    return {
      userId: link?.data?.user?.id || null,
      actionLink: link?.data?.action_link || link?.data?.properties?.action_link || null
    }
  }

  try {
    const generated = await generateRecoveryLink()
    userId = generated.userId || userId
    actionLink = generated.actionLink || actionLink
    method = 'recovery'
  } catch (e) {
    lastErr = e
    console.error('generateLink(recovery) failed:', e?.message || e)
  }

  if (!userId) {
    userId = await findUserId()
    if (userId && !method) method = 'existingUser'
  }

  if (!actionLink) {
    if (!userId) {
      try {
        const created = await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          email_confirm: true
        })
        userId = created?.data?.user?.id || userId
        method = method || 'createUser'
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          const err = new Error('create_user_failed')
          err.code = 'create_user_failed'
          err.detail = e?.message || 'create_user_failed'
          err.status = e?.status || e?.response?.status || null
          throw err
        }
      }
      if (!userId) {
        userId = await findUserId()
      }
    }

    try {
      const retry = await generateRecoveryLink()
      userId = retry.userId || userId
      actionLink = retry.actionLink || actionLink
      method = userId ? 'recovery_retry' : method
    } catch (e) {
      lastErr = e
      console.error('generateLink(recovery) retry failed:', e?.message || e)
    }
  }

  if (!userId) {
    const err = new Error('add_member_no_user_id')
    err.code = 'add_member_no_user_id'
    err.detail = 'Could not create or locate user for this email.'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  if (requireActionLink && !actionLink) {
    const err = new Error('generate_recovery_link_failed')
    err.code = 'generate_recovery_link_failed'
    err.detail = lastErr?.message || 'Failed to generate recovery link'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  return { userId, actionLink, method }
}

module.exports = { ensureUserIdAndInvite, ensureUserIdAndRecoveryLink };

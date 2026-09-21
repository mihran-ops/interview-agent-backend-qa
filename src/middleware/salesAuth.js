'use strict'

const { supabaseAdmin } = require('../clients/supabase')

function createRequireSalesRep(options = {}) {
  const db = options.db || supabaseAdmin
  return async function requireSalesRep(req, res, next) {
    const userId = String(req.user?.id || '').trim()
    const verifiedEmail = String(req.user?.email || '').trim()
    if (!userId) {
      return res.status(401).json({
        error: 'authentication_required',
        code: 'authentication_required',
        detail: 'Sign in to continue.'
      })
    }

    try {
      const { data: rep, error: repError } = await db
        .from('sales_reps')
        .select('user_id,email,display_name,active')
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle()
      if (repError) {
        console.error('[sales/auth] sales_rep_lookup_failed', {
          request_id: req.request_id || null,
          code: repError.code || null
        })
        return res.status(503).json({
          error: 'sales_access_unavailable',
          code: 'sales_access_unavailable',
          detail: 'Sales access could not be verified.',
          request_id: req.request_id || null
        })
      }
      if (rep) {
        req.salesRep = {
          user_id: rep.user_id,
          email: rep.email,
          display_name: rep.display_name,
          access_role: 'sales_rep'
        }
        return next()
      }

      if (verifiedEmail) {
        const { data: admin, error: adminError } = await db
          .from('admins')
          .select('id,is_active')
          .eq('email', verifiedEmail)
          .eq('is_active', true)
          .maybeSingle()
        if (adminError) {
          console.error('[sales/auth] admin_lookup_failed', {
            request_id: req.request_id || null,
            code: adminError.code || null
          })
          return res.status(503).json({
            error: 'sales_access_unavailable',
            code: 'sales_access_unavailable',
            detail: 'Sales access could not be verified.',
            request_id: req.request_id || null
          })
        }
        if (admin) {
          req.salesRep = {
            user_id: userId,
            email: verifiedEmail,
            display_name: 'Global Admin',
            access_role: 'global_admin'
          }
          return next()
        }
      }

      return res.status(403).json({
        error: 'sales_access_denied',
        code: 'sales_access_denied',
        detail: 'Sales access is not enabled for this account.',
        request_id: req.request_id || null
      })
    } catch (error) {
      console.error('[sales/auth] unexpected', {
        request_id: req.request_id || null,
        error: error?.message || String(error)
      })
      return res.status(503).json({
        error: 'sales_access_unavailable',
        code: 'sales_access_unavailable',
        detail: 'Sales access could not be verified.',
        request_id: req.request_id || null
      })
    }
  }
}

module.exports = { createRequireSalesRep }

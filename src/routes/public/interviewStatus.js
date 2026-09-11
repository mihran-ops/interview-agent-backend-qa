'use strict';

const express = require('express');
const { supabase } = require('../../clients/supabase');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../../services/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../../services/roleLifecycle');
const { validateConfiguredInterviewDuration } = require('../../services/interviewDuration');
const { resolvePlanCapacityForClient } = require('../../services/planCapacity');

const router = express.Router();
const PUBLIC_STATUS_RATE_WINDOW_MS = 5 * 60 * 1000;
const PUBLIC_STATUS_RATE_MAX = 120;

async function publicStatusRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'public_interview_status',
      subjectKey: getRequestSubjectKey(req),
      windowMs: PUBLIC_STATUS_RATE_WINDOW_MS,
      maxCount: PUBLIC_STATUS_RATE_MAX
    });
    if (!result.allowed) {
      const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
      return res.status(429).json({
        error: 'rate_limited',
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Too many requests. Please try again later.',
        request_id
      });
    }
  } catch (error) {
    console.error('[rate-limit] public interview status check failed', {
      request_id: req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null,
      error: error?.message || error
    });
    const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
    return res.status(503).json({
      error: 'rate_limit_unavailable',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail: 'Request protection is temporarily unavailable. Please try again shortly.',
      request_id
    });
  }
  return next();
}

router.get('/interview-status', publicStatusRateLimit, async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const interview_id = String(req.query?.interview_id || '').trim();
    const role_token = String(req.query?.role_token || '').trim();

    if (!role_token) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'MISSING_REQUIRED_PARAMS',
        detail: 'role_token is required',
        hint: null,
        request_id
      });
    }

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id, client_id, status')
      .eq('slug_or_token', role_token)
      .maybeSingle();

    if (roleError || !role) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    if (!interview_id && isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'public_interview_status',
        request_id,
        role_id: role.id || null
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }

    let max_interview_minutes = null;
    if (role?.client_id) {
      let capacity;
      try {
        capacity = await resolvePlanCapacityForClient({
          db: supabase,
          clientId: role.client_id,
        });
      } catch (capacityError) {
        if (capacityError?.code === 'PLAN_CAPACITY_LOOKUP_FAILED') {
          return res.status(503).json({
            error: 'temporary_service_error',
            code: 'TEMPORARY_SERVICE_ERROR',
            detail: 'The service is temporarily unavailable. Please try again shortly.',
            retryable: true,
            request_id
          });
        }
        return res.status(503).json({
          error: 'interview_duration_not_configured',
          code: 'INTERVIEW_DURATION_NOT_CONFIGURED',
          detail: 'Interview duration is not configured. Please contact the hiring team.',
          retryable: false,
          request_id,
        });
      }
      const duration = validateConfiguredInterviewDuration(capacity.max_interview_minutes);
      if (!duration.ok) {
        return res.status(503).json({
          error: 'interview_duration_not_configured',
          code: 'INTERVIEW_DURATION_NOT_CONFIGURED',
          detail: 'Interview duration is not configured. Please contact the hiring team.',
          retryable: false,
          request_id
        });
      }
      max_interview_minutes = duration.minutes;
    }

    if (!interview_id) {
      return res.status(200).json({
        ok: true,
        interview_id: null,
        status: null,
        updated_at: null,
        max_interview_minutes,
        request_id
      });
    }

    const { data: interview, error: interviewError } = await supabase
      .from('interviews')
      .select('id, role_id, status, updated_at')
      .eq('id', interview_id)
      .maybeSingle();

    if (interviewError || !interview || String(interview.role_id || '') !== String(role.id || '')) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    return res.status(200).json({
      ok: true,
      interview_id: interview.id,
      status: interview.status || null,
      updated_at: interview.updated_at || null,
      max_interview_minutes,
      request_id
    });
  } catch (err) {
    return res.status(500).json({
      error: 'server_error',
      code: 'PUBLIC_INTERVIEW_STATUS_FAILED',
      detail: err?.message || 'Failed to load interview status',
      hint: null,
      request_id
    });
  }
});

module.exports = router;

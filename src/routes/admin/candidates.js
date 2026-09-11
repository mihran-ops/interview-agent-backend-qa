'use strict';

// Candidate listing and deletion. Mounted on the admin router.

const express = require('express');
const { entityFieldsForClientId, loadEntityMap, resolveEntityFilter, uniqueIds: uniqueEntityIds } = require('../../services/entityScopeFilter');
const { isInterviewRecoveryCoreEmailEnabled, isInterviewRecoveryCoreEnabled } = require('../../services/interviewAttemptService');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { applyAdminListRange, parseAdminListRange } = require('../../services/admin/adminHelpers');

const router = express.Router();

// List candidates for admin dashboard (requires client selection)
router.get('/candidates', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const client_id = String(req.query?.client_id || '').trim();
    const role_id = String(req.query?.role_id || '').trim();
    const entityFilter = req.query?.entity_filter || req.query?.entity_id || null;

    if (!client_id) {
      return res.json({ candidates: [], message: 'Select a client to view candidates.' });
    }

    let scopedClientIds = [client_id];
    let entityScope = { entitiesById: {} };
    if (entityFilter) {
      const resolved = await resolveEntityFilter({
        db: supabaseAdmin,
        req,
        clientId: client_id,
        entityFilter,
        requestId: request_id
      });
      if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
      scopedClientIds = resolved.clientIds;
      entityScope = resolved;
    }

    // Unpaginated by default so existing callers are unaffected; ?limit= and
    // ?offset= bound the response for callers that want it.
    const range = parseAdminListRange(req.query);
    if (range.invalid) return res.status(400).json({ error: `invalid_${range.invalid}` });
    let cq = supabaseAdmin
      .from('candidates')
      .select('id,created_at,client_id,role_id,name,email,status,interview_status,resume_url,analysis_summary,candidate_id,first_name,last_name')
      .order('created_at', { ascending: false });
    if (scopedClientIds.length === 1) cq = cq.eq('client_id', scopedClientIds[0]);
    else cq = cq.in('client_id', scopedClientIds);

    if (role_id) cq = cq.eq('role_id', role_id);
    cq = applyAdminListRange(cq, range);

    const { data: cands, error: cErr } = await cq;
    if (cErr) {
      console.error('[admin/candidates] list failed', {
        request_id,
        client_id,
        role_id: role_id || null,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'LIST_CANDIDATES_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    const candidateIds = Array.from(new Set((cands || []).map(c => c.id).filter(Boolean)));
    const roleIds = uniqueEntityIds((cands || []).map(c => c.role_id));
    const latestReportByCandidateId = {};
    const reportsByCandidateId = {};
    let roleClientById = {};

    if (roleIds.length) {
      let rolesQuery = supabaseAdmin
        .from('roles')
        .select('id,client_id')
        .in('id', roleIds);
      if (scopedClientIds.length === 1) rolesQuery = rolesQuery.eq('client_id', scopedClientIds[0]);
      else rolesQuery = rolesQuery.in('client_id', scopedClientIds);
      const { data: roles, error: rolesError } = await rolesQuery;
      if (rolesError) {
        console.error('[admin/candidates] roles lookup failed', {
          request_id,
          client_id,
          code: rolesError.code,
          message: rolesError.message
        });
      } else {
        roleClientById = Object.fromEntries((roles || []).map((role) => [role.id, role.client_id]));
      }
    }

    if (candidateIds.length) {
      let reportsQuery = supabaseAdmin
        .from('reports')
        .select('candidate_id,interview_id,attempt_number,report_kind,resume_score,interview_score,overall_score,report_url,created_at')
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) reportsQuery = reportsQuery.eq('client_id', scopedClientIds[0]);
      else reportsQuery = reportsQuery.in('client_id', scopedClientIds);

      const { data: reports, error: rErr } = await reportsQuery;

      if (rErr) {
        console.error('[admin/candidates] reports lookup failed', {
          request_id,
          client_id,
          code: rErr.code,
          message: rErr.message
        });
        return res.status(500).json({
          error: 'server_error',
          code: 'LIST_CANDIDATES_FAILED',
          detail: rErr.message,
          hint: rErr.hint || null,
          request_id
        });
      }

      for (const rep of (reports || [])) {
        if (rep?.candidate_id) {
          if (!reportsByCandidateId[rep.candidate_id]) reportsByCandidateId[rep.candidate_id] = [];
          reportsByCandidateId[rep.candidate_id].push(rep);
        }
        if (rep?.candidate_id && !latestReportByCandidateId[rep.candidate_id]) {
          latestReportByCandidateId[rep.candidate_id] = rep;
        }
      }
    }

    // Derive interview_score from latest interview transcript_scores.overall (matches client dashboard behavior)
    const latestInterviewByCandidateId = {};
    const transcriptOverallByCandidateId = {};

    if (candidateIds.length) {
      let interviewsQuery = supabaseAdmin
        .from('interviews')
        .select('id,candidate_id,created_at,attempt_number,replacement_authorization_id,transcript_scores,recording_status,recording_ready_at')
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });
      if (scopedClientIds.length === 1) interviewsQuery = interviewsQuery.eq('client_id', scopedClientIds[0]);
      else interviewsQuery = interviewsQuery.in('client_id', scopedClientIds);

      const { data: ivs, error: iErr } = await interviewsQuery;

      if (iErr) {
        console.error('[admin/candidates] interviews lookup failed', {
          request_id,
          client_id,
          code: iErr.code,
          message: iErr.message
        });
      } else {
        for (const iv of (ivs || [])) {
          if (iv?.candidate_id && !latestInterviewByCandidateId[iv.candidate_id]) {
            latestInterviewByCandidateId[iv.candidate_id] = iv;
          }
        }

        const clamp0to100Local = (v) => {
          if (!Number.isFinite(Number(v))) return null;
          const n = Number(v);
          return Math.max(0, Math.min(100, n));
        };

        for (const cid of candidateIds) {
          const iv = latestInterviewByCandidateId[cid];
          let ts = iv?.transcript_scores;
          if (typeof ts === 'string' && ts.trim()) {
            try { ts = JSON.parse(ts); } catch (_) { ts = null; }
          }
          const overall = ts && typeof ts === 'object' ? ts.overall : null;
          const clamped = clamp0to100Local(overall);
          if (clamped !== null) transcriptOverallByCandidateId[cid] = clamped;
        }
      }
    }

    const entityMap = {
      ...(entityScope.entitiesById || {}),
      ...(await loadEntityMap(supabaseAdmin, (cands || []).map((candidate) => roleClientById[candidate.role_id] || candidate.client_id)))
    };

    const candidates = (cands || []).map((c) => {
      const latestInterview = latestInterviewByCandidateId[c.id] || null;
      const candidateReports = reportsByCandidateId[c.id] || [];
      const exactAttemptReport = latestInterview
        ? candidateReports.find((report) => report.interview_id === latestInterview.id) || null
        : null;
      const isRecoveryAttempt = Number(latestInterview?.attempt_number || 0) > 1
        || !!latestInterview?.replacement_authorization_id;
      const rep = isRecoveryAttempt ? exactAttemptReport : (latestReportByCandidateId[c.id] || null);
      const resumeSource = candidateReports.find((report) => Number.isFinite(Number(report?.resume_score))) || rep;
      const resume_score = Number.isFinite(Number(resumeSource?.resume_score)) ? Number(resumeSource.resume_score) : null;
      const entityClientId = roleClientById[c.role_id] || c.client_id;
      const entityFields = entityFieldsForClientId(entityMap, entityClientId);

      const transcriptOverall = Object.prototype.hasOwnProperty.call(transcriptOverallByCandidateId, c.id)
        ? transcriptOverallByCandidateId[c.id]
        : null;

      const interview_score = Number.isFinite(Number(transcriptOverall)) ? Number(transcriptOverall) : null;

      const rep_overall = Number.isFinite(Number(rep?.overall_score)) ? Number(rep.overall_score) : null;

      const clamp0to100 = (v) => {
        if (!Number.isFinite(Number(v))) return null;
        const n = Number(v);
        return Math.max(0, Math.min(100, n));
      };

      const resumeClamped = clamp0to100(resume_score);
      const interviewClamped = clamp0to100(interview_score);
      const repOverallClamped = clamp0to100(rep_overall);

      let overall_score = null;
      if (resumeClamped !== null && interviewClamped !== null) {
        overall_score = clamp0to100((resumeClamped + interviewClamped) / 2);
      } else if (interviewClamped !== null) {
        overall_score = interviewClamped;
      } else if (resumeClamped !== null) {
        overall_score = resumeClamped;
      } else if (repOverallClamped !== null) {
        overall_score = repOverallClamped;
      }
      return {
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,
        ...entityFields,
        role_id: c.role_id,
        name: c.name || '',
        email: c.email || '',
        status: c.status || null,
        interview_status: c.interview_status || null,
        resume_url: c.resume_url || null,
        analysis_summary: c.analysis_summary || null,
        candidate_id: c.candidate_id || null,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        resume_score,
        interview_score,
        overall_score,
        latest_interview_id: latestInterview?.id || null,
        recording_status: latestInterview?.recording_status || null,
        recording_ready_at: latestInterview?.recording_ready_at || null,
        latest_report_url: rep?.report_url || null,
        report_generated_at: rep?.created_at || null
      };
    });

    return res.json({
      candidates,
      features: {
        interview_recovery_core: isInterviewRecoveryCoreEnabled(),
        interview_recovery_core_email: isInterviewRecoveryCoreEmailEnabled(),
      },
    });
  } catch (e) {
    console.error('[admin/candidates] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'LIST_CANDIDATES_FAILED',
      detail: e?.message || 'Failed to list candidates',
      hint: null,
      request_id
    });
  }
});

// Delete candidate by id + client_id (safety guard)
router.delete('/candidates/:id', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const id = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();

    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data, error } = await supabaseAdmin
      .from('candidates')
      .delete()
      .eq('id', id)
      .eq('client_id', client_id)
      .select('id')
      .maybeSingle();

    if (error) {
      const blockedByDependencies = error.code === '23503';
      console.error('[admin/candidates] delete failed', {
        request_id,
        id,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(blockedByDependencies ? 409 : 500).json({
        error: blockedByDependencies ? 'conflict' : 'server_error',
        code: blockedByDependencies ? 'CANDIDATE_DELETE_BLOCKED' : 'DELETE_CANDIDATE_FAILED',
        detail: error.message,
        hint: blockedByDependencies ? 'Candidate has dependent records; enable DB cascade or remove dependents first.' : (error.hint || null),
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found for provided id/client_id',
        hint: null,
        request_id
      });
    }

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[admin/candidates] delete unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'DELETE_CANDIDATE_FAILED',
      detail: e?.message || 'Failed to delete candidate',
      hint: null,
      request_id
    });
  }
});


module.exports = router;

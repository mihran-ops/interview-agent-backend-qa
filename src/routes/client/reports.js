// routes/reports.js
// Historical report-download router. Authorization and ownership fail closed.

'use strict';

const express = require('express');
const { supabase } = require('../../clients/supabase');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { normalizeUuid } = require('../../services/strictRequestValidation');

const router = express.Router();
const REPORTS_BUCKET = process.env.SUPABASE_REPORTS_BUCKET || 'reports';
const URL_TTL_SECONDS = Number(process.env.REPORTS_SIGNED_URL_TTL_SECONDS || 300);

function getScopedClientIds(req) {
  return Array.from(new Set([
    ...(Array.isArray(req?.clientScope?.memberships) ? req.clientScope.memberships.map((m) => m?.client_id) : []),
    ...(Array.isArray(req?.clientIds) ? req.clientIds : []),
    ...(Array.isArray(req?.client_memberships) ? req.client_memberships : []),
    ...(Array.isArray(req?.memberships) ? req.memberships.map((m) => m?.client_id) : []),
    req?.client?.id,
  ].filter((value) => typeof value === 'string' && value)));
}

function safeStorageKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().replace(/^\/+/, '');
  if (!key || key.length > 1000 || key.includes('\0') || key.split('/').includes('..')) return null;
  return key;
}

function keyFromReportUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return safeStorageKey(raw);
  try {
    const url = new URL(raw);
    for (const marker of [
      `/storage/v1/object/public/${REPORTS_BUCKET}/`,
      `/storage/v1/object/sign/${REPORTS_BUCKET}/`,
    ]) {
      const index = url.pathname.indexOf(marker);
      if (index !== -1) return safeStorageKey(decodeURIComponent(url.pathname.slice(index + marker.length)));
    }
  } catch (_) {}
  return null;
}

function boundedFailure(res, status, code) {
  return res.status(status).json({ error: code });
}

/**
 * GET /reports/:id/download
 * Signs only an explicitly stored report object after report, candidate, client,
 * role, optional interview, and authenticated scope all agree.
 */
router.get('/:id/download', requireAuth, withClientScope, async (req, res) => {
  const id = normalizeUuid(req.params.id);
  if (id === null) return boundedFailure(res, 400, 'invalid_report_id');

  try {
    const { data: report, error: reportError } = await supabase
      .from('reports')
      .select('id,storage_path,path,file_path,report_url,candidate_id,client_id,role_id,interview_id')
      .eq('id', id)
      .maybeSingle();
    if (reportError) return boundedFailure(res, 503, 'report_lookup_unavailable');
    if (!report) return boundedFailure(res, 404, 'report_not_found');

    const candidateId = normalizeUuid(report.candidate_id);
    if (candidateId === null) return boundedFailure(res, 403, 'report_access_denied');
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('id,client_id,role_id')
      .eq('id', candidateId)
      .maybeSingle();
    if (candidateError) return boundedFailure(res, 503, 'report_lookup_unavailable');
    if (!candidate) return boundedFailure(res, 403, 'report_access_denied');

    const candidateClientId = normalizeUuid(candidate.client_id);
    const candidateRoleId = normalizeUuid(candidate.role_id);
    const reportClientId = report.client_id == null ? undefined : normalizeUuid(report.client_id);
    const reportRoleId = report.role_id == null ? undefined : normalizeUuid(report.role_id);
    if (candidateClientId === null || candidateRoleId === null || reportClientId === null || reportRoleId === null) {
      return boundedFailure(res, 403, 'report_access_denied');
    }
    const effectiveClientId = reportClientId || candidateClientId;
    if (!effectiveClientId || (reportClientId && reportClientId !== candidateClientId)
      || (reportRoleId && reportRoleId !== candidateRoleId)
      || !getScopedClientIds(req).includes(effectiveClientId)) {
      return boundedFailure(res, 403, 'report_access_denied');
    }

    if (report.interview_id != null) {
      const interviewId = normalizeUuid(report.interview_id);
      if (interviewId === null) return boundedFailure(res, 403, 'report_access_denied');
      const { data: interview, error: interviewError } = await supabase
        .from('interviews')
        .select('id,candidate_id,client_id,role_id')
        .eq('id', interviewId)
        .maybeSingle();
      if (interviewError) return boundedFailure(res, 503, 'report_lookup_unavailable');
      if (!interview
        || interview.candidate_id !== candidateId
        || interview.client_id !== effectiveClientId
        || interview.role_id !== candidateRoleId) {
        return boundedFailure(res, 403, 'report_access_denied');
      }
    }

    const storagePath = safeStorageKey(report.storage_path)
      || safeStorageKey(report.path)
      || safeStorageKey(report.file_path)
      || keyFromReportUrl(report.report_url);
    if (!storagePath) return boundedFailure(res, 404, 'report_file_not_found');

    const { data: signed, error: signError } = await supabase.storage
      .from(REPORTS_BUCKET)
      .createSignedUrl(storagePath, URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) return boundedFailure(res, 404, 'report_file_not_found');
    return res.redirect(302, signed.signedUrl);
  } catch (_) {
    return boundedFailure(res, 503, 'report_lookup_unavailable');
  }
});

module.exports = router;

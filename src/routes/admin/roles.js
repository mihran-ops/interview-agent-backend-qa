'use strict';

// Role administration, including rubric and interview configuration. Mounted on the admin router.

const express = require('express');
const { generateRubricAndKBForRole, makeKBFromRubric } = require('../../services/generateRubric');
const { ensureTavusDocumentForRole } = require('../../services/tavusDocuments');
const { loadEntityMap, resolveEntityFilter, withEntityFields } = require('../../services/entityScopeFilter');
const { normalizeInterviewType, normalizeRoleInterviewTypeForRead } = require('../../services/interviewTypes');
const { getRoleInterviewAvailability } = require('../../services/roleInterviewAvailability');
const { getRoleJdReplacementEligibility } = require('../../services/roleJdReplacement');
const { syncRoleCreditsForStatusChange } = require('../../services/interviewCredits');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();

// List roles (optional client filter)
router.get('/roles', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const { client_id } = req.query
  const statusFilter = String(req.query.status || 'active').trim().toLowerCase()
  if (!['active', 'inactive', 'all'].includes(statusFilter)) {
    return res.status(400).json({
      error: 'bad_request',
      code: 'INVALID_ROLE_STATUS_FILTER',
      detail: 'status must be active, inactive, or all',
      hint: null,
      request_id
    })
  }
  const entityFilter = req.query.entity_filter || req.query.entity_id || null
  let scopedClientIds = client_id ? [String(client_id).trim()].filter(Boolean) : []
  let entityScope = { entitiesById: {} }
  if (entityFilter) {
    const resolved = await resolveEntityFilter({
      db: supabaseAdmin,
      req,
      clientId: client_id,
      entityFilter,
      requestId: request_id
    })
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
    scopedClientIds = resolved.clientIds
    entityScope = resolved
  }
  let q = supabaseAdmin.from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at,status,closed_at,closed_by,inactive_reason')
    .order('created_at', { ascending: false })
  if (scopedClientIds.length === 1) q = q.eq('client_id', scopedClientIds[0])
  else if (scopedClientIds.length > 1) q = q.in('client_id', scopedClientIds)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: 'list_roles_failed', code: 'LIST_ROLES_FAILED', detail: error.message, hint: error.hint || null, request_id })
  const rows = data || []
  let replacementEligibilityByRoleId = {}
  try {
    replacementEligibilityByRoleId = await getRoleJdReplacementEligibility({ db: supabaseAdmin, roles: rows })
  } catch (eligibilityError) {
    console.error('[admin/roles] replacement eligibility lookup failed', eligibilityError)
    return res.status(500).json({
      error: 'list_role_replacement_eligibility_failed',
      code: 'LIST_ROLE_REPLACEMENT_ELIGIBILITY_FAILED',
      detail: null,
      hint: null,
      request_id
    })
  }
  const entityMap = {
    ...(entityScope.entitiesById || {}),
    ...(await loadEntityMap(supabaseAdmin, rows.map((role) => role.client_id)))
  }
  const availabilityFallback = {
    included_interviews_per_role: null,
    purchased_interviews: null,
    used_interviews: null,
    remaining_interviews: null
  }
  const items = await Promise.all(rows.map(async (rawRole) => {
    const role = normalizeRoleInterviewTypeForRead(rawRole)
    try {
      if (!role?.id || !role?.client_id) {
        return withEntityFields({
          ...role,
          ...availabilityFallback,
          job_description_replacement: replacementEligibilityByRoleId[role?.id] || {
            eligible: false,
            blockers: ['eligibility_unavailable']
          }
        }, entityMap, role?.client_id)
      }
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id
      })
      return withEntityFields({
        ...role,
        included_interviews_per_role: availability?.included_interviews_per_role ?? null,
        purchased_interviews: availability?.purchased_interviews ?? null,
        used_interviews: availability?.used_interviews ?? null,
        remaining_interviews: availability?.remaining_interviews ?? null,
        job_description_replacement: replacementEligibilityByRoleId[role.id] || {
          eligible: false,
          blockers: ['eligibility_unavailable']
        }
      }, entityMap, role.client_id)
    } catch (e) {
      console.warn('[admin/roles] availability lookup failed', {
        role_id: role?.id || null,
        client_id: role?.client_id || null,
        error: e?.message || e
      })
      return withEntityFields({
        ...role,
        ...availabilityFallback,
        job_description_replacement: replacementEligibilityByRoleId[role?.id] || {
          eligible: false,
          blockers: ['eligibility_unavailable']
        }
      }, entityMap, role?.client_id)
    }
  }))
  res.json({ items })
})

// Create role (keeps existing rubric+KB generation)
router.post('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, title } = req.body || {}
  let { interview_type, job_description_url } = req.body || {}

  if (!client_id || !title || !title.trim()) {
    return res.status(400).json({ error: 'client_id_and_title_required' })
  }
  const interviewTypeRaw = String(interview_type || '').trim()
  interview_type = normalizeInterviewType(interviewTypeRaw, {
    fallback: interviewTypeRaw ? null : 'core'
  })
  if (!interview_type) return res.status(400).json({ error: 'invalid_interview_type' })

  const { data: role, error } = await supabaseAdmin
    .from('roles')
    .insert({
      client_id,
      title: title.trim(),
      interview_type,
      job_description_url: job_description_url || null
    })
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .single()
  if (error) return res.status(500).json({ error: 'create_role_failed', detail: error.message })

  const hasInitialJobDescriptionUrl = typeof role?.job_description_url === 'string' && role.job_description_url.trim().length > 0
  if (hasInitialJobDescriptionUrl) {
    try {
      await generateRubricAndKBForRole(role.id)
    } catch (e) {
      console.error('enrich_role_failed:', e?.message || e)
    }
  }

  const { data: updated } = await supabaseAdmin
    .from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .eq('id', role.id)
    .single()

  res.json({ item: normalizeRoleInterviewTypeForRead(updated || role) })
})

router.patch('/roles/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = String(req.params.id || '').trim()
    const clientId = String(req.query.client_id || req.body?.client_id || '').trim()
    const status = String(req.body?.status || '').trim().toLowerCase()
    if (!roleId) return res.status(400).json({ error: 'id_required' })
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'INVALID_ROLE_STATUS',
        detail: 'status must be active or inactive'
      })
    }

    let lookup = supabaseAdmin
      .from('roles')
      .select('id,client_id')
      .eq('id', roleId)
    if (clientId) lookup = lookup.eq('client_id', clientId)
    const { data: roleRow, error: lookupErr } = await lookup.maybeSingle()
    if (lookupErr) return res.status(500).json({ error: 'role_lookup_failed', detail: lookupErr.message })
    if (!roleRow) return res.status(404).json({ error: 'not_found' })

    const reason = String(req.body?.inactive_reason || '').trim()
    const patch = status === 'inactive'
      ? {
        status: 'inactive',
        closed_at: new Date().toISOString(),
        closed_by: req.user?.id || null,
        inactive_reason: reason || null
      }
      : {
        status: 'active',
        closed_at: null,
        closed_by: null,
        inactive_reason: null
      }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .update(patch)
      .eq('id', roleId)
      .eq('client_id', roleRow.client_id)
      .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at,status,closed_at,closed_by,inactive_reason')
      .maybeSingle()
    if (error) return res.status(500).json({ error: 'role_status_update_failed', detail: error.message })
    if (!data) return res.status(404).json({ error: 'not_found' })

    await syncRoleCreditsForStatusChange({
      db: supabaseAdmin,
      clientId: roleRow.client_id,
      roleId,
      status,
      closedAt: data.closed_at
    })

    return res.json({ item: normalizeRoleInterviewTypeForRead(data) })
  } catch (e) {
    console.error('role_status_update_exception:', e?.message || e)
    return res.status(500).json({ error: 'server_error' })
  }
})

// Delete role by id + client_id (matches FE call shape)
router.delete('/roles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Alternate delete endpoint via POST body { id, client_id }
router.post('/roles/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('post_delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('post_delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Get editable role config
router.get('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/config] fetch failed', {
        request_id,
        role_id: roleId,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_ROLE_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found',
        hint: null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        rubric: data.rubric || null,
        manual_questions: data.manual_questions || null,
        job_description_text: data.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch role config',
      hint: null,
      request_id
    });
  }
});

// Update editable role config
router.patch('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
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

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};
    let responseRubricQuestions;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric')) {
      updates.rubric = req.body.rubric;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'manual_questions')) {
      updates.manual_questions = req.body.manual_questions;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide rubric and/or manual_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .single();

    if (updateErr) {
      console.error('[admin/roles/config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        rubric: updated.rubric || null,
        manual_questions: updated.manual_questions || null,
        job_description_text: updated.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to update role config',
      hint: null,
      request_id
    });
  }
});

router.get('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
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
      .from('roles')
      .select('id,client_id,title,tavus_prompt,rubric_questions,rubric,manual_questions')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/interview-config] fetch failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_INTERVIEW_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data || String(data.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    // --- BEGIN: rubric_questions_out computation ---
    const directQuestions = Array.isArray(data.rubric_questions)
      ? data.rubric_questions
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter(Boolean)
      : [];

    let rubric_questions_out = directQuestions;

    if (!rubric_questions_out.length) {
      const out = [];
      const seen = new Set();
      const add = (value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || seen.has(text)) return;
        seen.add(text);
        out.push(text);
      };

      let parsed = data.rubric;
      if (typeof parsed === 'string' && parsed.trim()) {
        try {
          parsed = JSON.parse(parsed);
        } catch (_) {
          parsed = null;
        }
      }

      const parsedQuestions = parsed && typeof parsed === 'object'
        ? (Array.isArray(parsed?.questions) ? parsed.questions : (Array.isArray(parsed) ? parsed : null))
        : null;

      if (Array.isArray(parsedQuestions) && parsedQuestions.length) {
        for (const item of parsedQuestions) {
          if (typeof item === 'string') {
            add(item);
          } else if (item && typeof item === 'object') {
            if (typeof item.question === 'string') add(item.question);
            else if (typeof item.text === 'string') add(item.text);
            else if (typeof item.prompt === 'string') add(item.prompt);
          }
        }
      }

      if (!out.length && typeof data.manual_questions === 'string' && data.manual_questions.trim()) {
        data.manual_questions
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach(add);
      }

      rubric_questions_out = out;
    }
    // --- END: rubric_questions_out computation ---

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        tavus_prompt: data.tavus_prompt || null,
        rubric_questions: rubric_questions_out
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch interview config',
      hint: null,
      request_id
    });
  }
});

router.patch('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  let responseRubricQuestions;
  let rubricQuestionsEdited = false;
  let updatedRubricForSync = null;
  try {
    const roleId = req.params.id;
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

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/interview-config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tavus_prompt')) {
      const v = req.body.tavus_prompt;
      if (v !== null && typeof v !== 'string') {
        return res.status(400).json({
          error: 'bad_request',
          code: 'INVALID_TAVUS_PROMPT',
          detail: 'tavus_prompt must be a string or null',
          hint: null,
          request_id
        });
      }
      updates.tavus_prompt = v;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric_questions')) {
      const rq = req.body.rubric_questions;
      responseRubricQuestions = rq;
      if (rq !== null) {
        if (!Array.isArray(rq) || rq.some((q) => typeof q !== 'string')) {
          return res.status(400).json({
            error: 'bad_request',
            code: 'INVALID_RUBRIC_QUESTIONS',
            detail: 'rubric_questions must be null or an array of strings',
            hint: null,
            request_id
          });
        }
        const cleanedQuestions = rq.map((q) => String(q || '').trim()).filter(Boolean);
        const normalizeQuestionKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const closedEndedStartRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b/i;
        const openEndedContinuationRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b[\s,:-]*(please\s+)?(tell me about|walk me through|describe\b|how have you\b|what was your approach to\b|explain\b|share\b|give me an example\b)/i;
        const seenQuestionKeys = new Set();
        for (const question of cleanedQuestions) {
          const key = normalizeQuestionKey(question);
          if (seenQuestionKeys.has(key)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions contains duplicate questions',
              hint: null,
              request_id
            });
          }
          seenQuestionKeys.add(key);
          if (closedEndedStartRe.test(question) && !openEndedContinuationRe.test(question)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions must be open-ended and not yes/no style',
              hint: null,
              request_id
            });
          }
        }
        responseRubricQuestions = cleanedQuestions;
        let parsedRubric = null;
        if (typeof existing?.rubric === 'string' && existing.rubric.trim()) {
          try {
            parsedRubric = JSON.parse(existing.rubric);
          } catch {}
        } else if (existing?.rubric && typeof existing.rubric === 'object') {
          parsedRubric = existing.rubric;
        }

        const normalizeQuestion = (value) => String(value || '').trim().toLowerCase();
        const existingCategoryByQuestion = new Map();
        const existingQuestions = Array.isArray(parsedRubric?.questions) ? parsedRubric.questions : [];
        for (const item of existingQuestions) {
          if (!item || typeof item !== 'object') continue;
          const questionText = normalizeQuestion(item.text || item.question || item.prompt);
          if (!questionText) continue;
          const category = typeof item.category === 'string' && item.category.trim() ? item.category : 'Custom';
          if (!existingCategoryByQuestion.has(questionText)) {
            existingCategoryByQuestion.set(questionText, category);
          }
        }

        const newRubricObject = {
          questions: cleanedQuestions.map((q) => ({
            text: q,
            category: existingCategoryByQuestion.get(normalizeQuestion(q)) || 'Custom'
          }))
        };
        updates.rubric = newRubricObject;
        updates.rubric_questions = newRubricObject.questions;
        rubricQuestionsEdited = true;
        updatedRubricForSync = newRubricObject;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide tavus_prompt and/or rubric_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,tavus_prompt,rubric')
      .single();

    if (updateErr) {
      console.error('[admin/roles/interview-config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    if (rubricQuestionsEdited && updatedRubricForSync) {
      try {
        const { data: roleForKbSync, error: roleForKbSyncErr } = await supabaseAdmin
          .from('roles')
          .select('id,title,kb_document_id')
          .eq('id', roleId)
          .eq('client_id', client_id)
          .maybeSingle();

        if (roleForKbSyncErr) throw roleForKbSyncErr;

        if (roleForKbSync?.kb_document_id) {
          const kbJson = makeKBFromRubric(updatedRubricForSync);
          const kbKey = `${roleForKbSync.kb_document_id}.json`;
          const kbPayload = JSON.stringify(kbJson, null, 2);
          let kbUploadError = null;

          const { error: kbUploadErr } = await supabaseAdmin.storage
            .from('kbs')
            .upload(kbKey, new Blob([kbPayload], { type: 'application/json' }), {
              contentType: 'application/json',
              upsert: true
            });
          kbUploadError = kbUploadErr || null;

          if (kbUploadError) {
            const { error: kbUploadErr2 } = await supabaseAdmin.storage
              .from('kbs')
              .upload(kbKey, Buffer.from(kbPayload), {
                contentType: 'application/json',
                upsert: true
              });
            kbUploadError = kbUploadErr2 || null;
          }

          if (kbUploadError) throw kbUploadError;

          await ensureTavusDocumentForRole(
            { id: roleForKbSync.id, title: roleForKbSync.title, kb_document_id: roleForKbSync.kb_document_id },
            { supabase: supabaseAdmin, rubric: updatedRubricForSync, forceRefresh: true }
          );
        }
      } catch (syncErr) {
        console.error('[admin/roles/interview-config] kb_tavus_sync_failed', {
          request_id,
          role_id: roleId,
          client_id,
          error: syncErr?.message || syncErr
        });
      }
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        tavus_prompt: updated.tavus_prompt || null,
        rubric_questions: responseRubricQuestions === undefined
          ? (() => {
              const questions = Array.isArray(updated?.rubric?.questions) ? updated.rubric.questions : [];
              const out = questions
                .map((item) => {
                  if (!item || typeof item !== 'object') return '';
                  const text = item.text || item.question || item.prompt;
                  return typeof text === 'string' ? text.trim() : '';
                })
                .filter(Boolean);
              return out.length ? out : null;
            })()
          : (Array.isArray(responseRubricQuestions) ? responseRubricQuestions : null)
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to update interview config',
      hint: null,
      request_id
    });
  }
});


module.exports = router;

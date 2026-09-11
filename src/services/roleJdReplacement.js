'use strict';

const path = require('path');
const { randomUUID } = require('crypto');
const { getPlanCapacity } = require('./planCapacity');

const JD_MAX_BYTES = 20 * 1024 * 1024;
const JD_FILE_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
});
const ROLE_ACTIVITY_CHECKS = Object.freeze([
  { table: 'candidates', label: 'candidates' },
  { table: 'interviews', label: 'interviews' },
  { table: 'reports', label: 'reports' },
  { table: 'otp_tokens', label: 'otp_tokens' },
  { table: 'accommodation_requests', label: 'accommodation_requests' },
  { table: 'automation_rules', label: 'automation_rules', activeOnly: true },
  { table: 'automation_evaluations', label: 'automation_evaluations' },
  { table: 'automation_actions', label: 'automation_actions' },
  { table: 'automation_digest_deliveries', label: 'automation_digest_deliveries' },
  { table: 'digest_logs', label: 'digest_logs' }
]);

class RoleJdReplacementError extends Error {
  constructor(message, { status = 500, code = 'ROLE_JD_REPLACEMENT_FAILED', stage = 'unknown', detail = null } = {}) {
    super(message);
    this.name = 'RoleJdReplacementError';
    this.status = status;
    this.code = code;
    this.stage = stage;
    this.detail = detail;
  }
}

function supportedJdFile(file) {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
    throw new RoleJdReplacementError('A job description file is required.', {
      status: 400,
      code: 'JD_FILE_REQUIRED',
      stage: 'validation'
    });
  }
  if (!JD_FILE_TYPES[ext]) {
    throw new RoleJdReplacementError('Only PDF or DOCX job descriptions are supported.', {
      status: 415,
      code: 'UNSUPPORTED_JD_FILE',
      stage: 'validation'
    });
  }
  if (file.buffer.length > JD_MAX_BYTES) {
    throw new RoleJdReplacementError('Job description file exceeds the 20MB limit.', {
      status: 413,
      code: 'JD_FILE_TOO_LARGE',
      stage: 'validation'
    });
  }
  return { ext, contentType: JD_FILE_TYPES[ext] };
}

function safeFileName(filename, ext) {
  const base = path.basename(String(filename || ''), ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    .slice(0, 100);
  return `${base || 'job-description'}${ext}`;
}

function normalizeGeneratedRubricQuestions(questions) {
  const seen = new Set();
  const normalized = [];

  for (const question of Array.isArray(questions) ? questions : []) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
    const text = String(question.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const category = String(question.category || '').replace(/\s+/g, ' ').trim() || 'auto';
    normalized.push({ ...question, text, category });
  }

  return normalized;
}

function rubricQuestionQualityError(detail = null) {
  return new RoleJdReplacementError('Generated rubric did not meet the exact plan-owned question contract.', {
    status: 502,
    code: 'RUBRIC_QUESTION_QUALITY_FAILED',
    stage: 'rubric_quality',
    detail
  });
}

function normalizeRoleId(value) {
  return String(value || '').trim();
}

function roleIsActive(role) {
  return String(role?.status || 'active').trim().toLowerCase() === 'active';
}

/**
 * Returns the same normalized blockers used by replacement preflight for one
 * or many roles. List routes can call this once per activity table instead of
 * running the replacement eligibility queries for every role row.
 */
async function getRoleJdReplacementEligibility({ db, roles = [] }) {
  const roleById = new Map();
  for (const role of roles || []) {
    const roleId = normalizeRoleId(role?.id || role);
    if (!roleId || roleById.has(roleId)) continue;
    roleById.set(roleId, typeof role === 'object' && role ? role : { id: roleId, status: 'active' });
  }

  const roleIds = Array.from(roleById.keys());
  const eligibilityByRoleId = Object.fromEntries(roleIds.map((roleId) => [
    roleId,
    {
      eligible: roleIsActive(roleById.get(roleId)),
      blockers: roleIsActive(roleById.get(roleId)) ? [] : ['role_not_active']
    }
  ]));
  if (!roleIds.length) return eligibilityByRoleId;

  const activityRowsByCheck = await Promise.all(ROLE_ACTIVITY_CHECKS.map(async (check) => {
    let query = db
      .from(check.table)
      .select('role_id');
    query = roleIds.length === 1
      ? query.eq('role_id', roleIds[0])
      : query.in('role_id', roleIds);
    if (check.activeOnly) query = query.is('archived_at', null);
    const { data, error } = await query;
    if (error) {
      throw new RoleJdReplacementError('Unable to verify role activity.', {
        status: 500,
        code: 'ROLE_ACTIVITY_CHECK_FAILED',
        stage: 'eligibility',
        detail: `${check.table}: ${error.message || error}`
      });
    }
    return { check, rows: data || [] };
  }));

  for (const { check, rows } of activityRowsByCheck) {
    for (const row of rows) {
      const roleId = normalizeRoleId(row?.role_id);
      const eligibility = eligibilityByRoleId[roleId];
      if (!eligibility || eligibility.blockers.includes(check.label)) continue;
      eligibility.blockers.push(check.label);
      eligibility.eligible = false;
    }
  }

  return eligibilityByRoleId;
}

async function findRoleActivity(db, roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  if (!normalizedRoleId) return [];
  const eligibilityByRoleId = await getRoleJdReplacementEligibility({
    db,
    roles: [{ id: normalizedRoleId, status: 'active' }]
  });
  return (eligibilityByRoleId[normalizedRoleId]?.blockers || [])
    .filter((blocker) => blocker !== 'role_not_active');
}

function mapCompletionError(error) {
  const message = String(error?.message || error || '');
  if (message.includes('ROLE_ACTIVITY_EXISTS')) {
    return new RoleJdReplacementError('Role activity started before replacement completed.', {
      status: 409,
      code: 'ROLE_ACTIVITY_EXISTS',
      stage: 'completion'
    });
  }
  if (message.includes('ROLE_NOT_ACTIVE')) {
    return new RoleJdReplacementError('Only active roles can have their job description replaced.', {
      status: 409,
      code: 'ROLE_NOT_ACTIVE',
      stage: 'completion'
    });
  }
  if (message.includes('ROLE_NOT_FOUND') || message.includes('REPLACEMENT_NOT_FOUND')) {
    return new RoleJdReplacementError('Role or replacement record was not found.', {
      status: 404,
      code: 'ROLE_OR_REPLACEMENT_NOT_FOUND',
      stage: 'completion'
    });
  }
  return new RoleJdReplacementError('Unable to activate the replacement job description.', {
    status: 500,
    code: 'ROLE_JD_COMPLETION_FAILED',
    stage: 'completion',
    detail: message || null
  });
}

function createRoleJdReplacementService(options = {}) {
  const db = options.db || require('../clients/supabase').supabaseAdmin;
  const parseBufferToText = options.parseBufferToText || require('../render/jdParser').parseBufferToText;
  const generateArtifacts = options.generateArtifacts || require('./generateRubric').generateJdDerivedArtifactsForRole;
  const ensureTavusDocument = options.ensureTavusDocument || require('./tavusDocuments').ensureTavusDocumentForRole;
  const createId = options.createId || randomUUID;
  const logger = options.logger || console;
  const bucket = String(
    options.bucket ||
    process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET ||
    process.env.SUPABASE_JD_BUCKET ||
    'job-descriptions'
  ).trim();

  async function recordFailure(replacementId, values, error) {
    if (!replacementId) return;
    const payload = {
      status: 'failed',
      ...values,
      error_metadata: {
        code: error?.code || 'ROLE_JD_REPLACEMENT_FAILED',
        stage: error?.stage || 'unknown',
        message: error?.message || 'Job description replacement failed',
        detail: error?.detail || null
      }
    };
    try {
      const { error: auditError } = await db
        .from('role_jd_replacements')
        .update(payload)
        .eq('id', replacementId)
        .eq('status', 'processing');
      if (auditError) logger.error('[role-jd-replacement] failed to record failure', auditError.message || auditError);
    } catch (auditError) {
      logger.error('[role-jd-replacement] failed to record failure', auditError?.message || auditError);
    }
  }

  async function replaceJobDescription({ roleId, clientId, file, reason, actorUserId, actorType }) {
    const safeRoleId = String(roleId || '').trim();
    const safeClientId = String(clientId || '').trim();
    if (!safeRoleId || !safeClientId) {
      throw new RoleJdReplacementError('role id and client_id are required.', {
        status: 400,
        code: 'ROLE_AND_CLIENT_REQUIRED',
        stage: 'validation'
      });
    }

    const { data: role, error: roleError } = await db
      .from('roles')
      .select('id,client_id,title,description,interview_type,manual_questions,status,job_description_url,job_description_text,rubric,rubric_questions,kb_document_id,tavus_document_id,tavus_prompt')
      .eq('id', safeRoleId)
      .eq('client_id', safeClientId)
      .maybeSingle();
    if (roleError) {
      throw new RoleJdReplacementError('Unable to load role.', {
        status: 500,
        code: 'ROLE_LOOKUP_FAILED',
        stage: 'role_lookup',
        detail: roleError.message || null
      });
    }
    if (!role) {
      throw new RoleJdReplacementError('Role not found for this client.', {
        status: 404,
        code: 'ROLE_NOT_FOUND',
        stage: 'role_lookup'
      });
    }
    const eligibilityByRoleId = await getRoleJdReplacementEligibility({ db, roles: [role] });
    const eligibility = eligibilityByRoleId[safeRoleId] || { eligible: false, blockers: ['role_not_active'] };
    if (eligibility.blockers.includes('role_not_active')) {
      throw new RoleJdReplacementError('Only active roles can have their job description replaced.', {
        status: 409,
        code: 'ROLE_NOT_ACTIVE',
        stage: 'eligibility'
      });
    }

    if (!eligibility.eligible) {
      throw new RoleJdReplacementError('Job description replacement is blocked after role activity begins.', {
        status: 409,
        code: 'ROLE_ACTIVITY_EXISTS',
        stage: 'eligibility',
        detail: eligibility.blockers.join(',')
      });
    }

    const { ext, contentType } = supportedJdFile(file);
    const replacementId = createId();
    const objectKey = `${safeClientId}/${safeRoleId}/replacements/${replacementId}/${safeFileName(file.originalname, ext)}`;
    const newJobDescriptionUrl = `${bucket}/${objectKey}`;
    let stagedValues = { new_job_description_url: newJobDescriptionUrl };

    const auditPayload = {
      id: replacementId,
      role_id: safeRoleId,
      client_id: safeClientId,
      actor_user_id: actorUserId || null,
      actor_type: actorType || null,
      reason: String(reason || '').trim().slice(0, 2000) || null,
      status: 'processing',
      old_job_description_url: role.job_description_url || null,
      new_job_description_url: newJobDescriptionUrl,
      old_job_description_text: role.job_description_text || null,
      old_description: role.description || null,
      old_kb_document_id: role.kb_document_id || null,
      old_tavus_document_id: role.tavus_document_id || null,
      old_tavus_prompt: role.tavus_prompt || null,
      old_rubric: role.rubric || null,
      old_rubric_questions: role.rubric_questions || null
    };
    const { error: auditInsertError } = await db
      .from('role_jd_replacements')
      .insert(auditPayload);
    if (auditInsertError) {
      throw new RoleJdReplacementError('Unable to start replacement history.', {
        status: 500,
        code: 'REPLACEMENT_AUDIT_CREATE_FAILED',
        stage: 'audit',
        detail: auditInsertError.message || null
      });
    }

    try {
      const { error: uploadError } = await db.storage
        .from(bucket)
        .upload(objectKey, file.buffer, { contentType, upsert: false });
      if (uploadError) {
        throw new RoleJdReplacementError('Job description upload failed.', {
          status: 500,
          code: 'JD_UPLOAD_FAILED',
          stage: 'upload',
          detail: uploadError.message || null
        });
      }

      let jdText;
      try {
        jdText = String(await parseBufferToText(file.buffer, contentType, file.originalname) || '').trim();
      } catch (error) {
        throw new RoleJdReplacementError('Job description could not be parsed.', {
          status: error?.status === 415 ? 415 : 422,
          code: 'JD_PARSE_FAILED',
          stage: 'parse',
          detail: error?.message || null
        });
      }
      if (!jdText) {
        throw new RoleJdReplacementError('Job description did not contain readable text.', {
          status: 422,
          code: 'JD_TEXT_EMPTY',
          stage: 'parse'
        });
      }
      stagedValues = {
        ...stagedValues,
        new_job_description_text: jdText
      };

      let artifacts;
      try {
        artifacts = await generateArtifacts(
          { role, jdText },
          { supabaseClient: db, logger }
        );
      } catch (error) {
        if (error?.code === 'RUBRIC_QUESTION_QUALITY_FAILED') {
          throw rubricQuestionQualityError(error.detail || null);
        }
        throw new RoleJdReplacementError('JD-derived role artifacts could not be generated.', {
          status: 502,
          code: 'JD_ARTIFACT_GENERATION_FAILED',
          stage: 'generation',
          detail: error?.message || null
        });
      }
      if (artifacts?.kb_document_id) {
        stagedValues = {
          ...stagedValues,
          new_kb_document_id: artifacts.kb_document_id
        };
      }
      if (!artifacts?.kb_document_id || !artifacts?.rubric || !Array.isArray(artifacts?.rubric_questions)) {
        throw new RoleJdReplacementError('JD-derived role artifacts were incomplete.', {
          status: 502,
          code: 'JD_ARTIFACTS_INCOMPLETE',
          stage: 'generation'
        });
      }
      const rubricQuestions = normalizeGeneratedRubricQuestions(artifacts.rubric_questions);
      const artifactCapacity = getPlanCapacity(artifacts.rubric.membership_level);
      if (!artifactCapacity || rubricQuestions.length !== artifactCapacity.scored_question_count) {
        throw rubricQuestionQualityError({
          membership_level: artifacts.rubric.membership_level || null,
          expected_question_count: artifactCapacity?.scored_question_count || null,
          valid_question_count: rubricQuestions.length,
        });
      }
      artifacts = {
        ...artifacts,
        rubric: { ...artifacts.rubric, questions: rubricQuestions },
        rubric_questions: rubricQuestions
      };
      stagedValues = {
        ...stagedValues,
        new_description: artifacts.description || null,
        new_rubric: artifacts.rubric,
        new_rubric_questions: artifacts.rubric_questions,
        new_kb_document_id: artifacts.kb_document_id
      };

      let tavusDocumentId;
      try {
        tavusDocumentId = await ensureTavusDocument(
          {
            id: role.id,
            title: role.title,
            kb_document_id: artifacts.kb_document_id,
            tavus_document_id: null
          },
          {
            supabase: db,
            rubric: artifacts.rubric,
            forceRefresh: true,
            persist: false
          }
        );
      } catch (error) {
        throw new RoleJdReplacementError('Tavus document creation failed.', {
          status: 502,
          code: 'TAVUS_DOCUMENT_CREATION_FAILED',
          stage: 'tavus',
          detail: error?.message || null
        });
      }
      if (!tavusDocumentId) {
        throw new RoleJdReplacementError('Tavus document creation did not return a document id.', {
          status: 503,
          code: 'TAVUS_DOCUMENT_UNAVAILABLE',
          stage: 'tavus'
        });
      }
      stagedValues = {
        ...stagedValues,
        new_tavus_document_id: tavusDocumentId,
        new_tavus_prompt: null
      };

      const { data: updatedRole, error: completionError } = await db.rpc(
        'complete_role_jd_replacement',
        {
          p_replacement_id: replacementId,
          p_role_id: safeRoleId,
          p_client_id: safeClientId,
          p_new_job_description_url: newJobDescriptionUrl,
          p_new_job_description_text: jdText,
          p_new_description: artifacts.description || null,
          p_new_rubric: artifacts.rubric,
          p_new_rubric_questions: artifacts.rubric_questions,
          p_new_kb_document_id: artifacts.kb_document_id,
          p_new_tavus_document_id: tavusDocumentId,
          p_new_tavus_prompt: null
        }
      );
      if (completionError) throw mapCompletionError(completionError);

      return {
        ok: true,
        replacement_id: replacementId,
        role: updatedRole
      };
    } catch (error) {
      const replacementError = error instanceof RoleJdReplacementError
        ? error
        : new RoleJdReplacementError('Job description replacement failed.', {
            detail: error?.message || null
          });
      await recordFailure(replacementId, stagedValues, replacementError);
      throw replacementError;
    }
  }

  return { replaceJobDescription };
}

module.exports = {
  JD_FILE_TYPES,
  JD_MAX_BYTES,
  ROLE_ACTIVITY_CHECKS,
  RoleJdReplacementError,
  createRoleJdReplacementService,
  findRoleActivity,
  getRoleJdReplacementEligibility,
  normalizeGeneratedRubricQuestions,
  supportedJdFile
};

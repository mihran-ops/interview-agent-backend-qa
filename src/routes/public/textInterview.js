// routes/textInterview.js
const express = require('express');
const Sentry = require('@sentry/node');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { OpenAI } = require('openai');
const analyzeResume = require('../../services/analyzeResume');
const { supabaseAdmin } = require('../../clients/supabase');
const { checkDuplicateCandidate } = require('../../services/duplicateCandidate');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../../services/roleInterviewAvailability');
const { syncInterviewCreditDraw } = require('../../services/interviewCredits');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../../services/roleLifecycle');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const TOKEN_SECRET = process.env.TEXT_INTERVIEW_JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '';
const TEXT_COMPLETION_NOTE = 'Completed via accommodation pathway (text).';
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const parseQuestions = (rubric) => {
  if (!rubric) return [];
  let parsed = rubric;
  if (typeof rubric === 'string') {
    try { parsed = JSON.parse(rubric); } catch { return []; }
  }
  const list = Array.isArray(parsed?.questions)
    ? parsed.questions
    : Array.isArray(parsed)
      ? parsed
      : [];
  return list
    .map((q) => {
      if (typeof q === 'string') return q.trim();
      if (q && typeof q === 'object') {
        const raw = q.question || q.prompt || q.text || '';
        return String(raw || '').trim();
      }
      return '';
    })
    .filter(Boolean);
};

const clampScore = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const toScoreOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};

const normalizeInlineText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function buildTextInterviewTranscript(answers, rubricQuestions = []) {
  const lines = ['INTERVIEW MODE: TEXT'];
  const items = Array.isArray(answers) ? answers : [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const question = normalizeInlineText(item.question || rubricQuestions[i] || '') || '[question missing]';
    const answer = normalizeInlineText(item.answer || '');
    lines.push('');
    lines.push(`QUESTION ${i + 1}: ${question}`);
    lines.push(`ANSWER ${i + 1}: ${answer || '[no answer provided]'}`);
  }
  return lines.join('\n');
}

function getUnansweredCandidateQuestions({ rubricQuestions, answers }) {
  if (!Array.isArray(rubricQuestions) || rubricQuestions.length === 0) return [];
  const items = Array.isArray(answers) ? answers : [];
  const answeredByQuestion = new Set();
  for (const item of items) {
    const question = normalizeInlineText(item?.question || '').toLowerCase();
    const answer = normalizeInlineText(item?.answer || '');
    if (question && answer) answeredByQuestion.add(question);
  }

  const unanswered = [];
  for (let i = 0; i < rubricQuestions.length; i += 1) {
    const question = normalizeInlineText(rubricQuestions[i] || '');
    if (!question) continue;
    const indexedAnswer = normalizeInlineText(items[i]?.answer || '');
    if (indexedAnswer) continue;
    if (answeredByQuestion.has(question.toLowerCase())) continue;
    unanswered.push(question);
  }
  return unanswered;
}

function assessAiAidedRiskFromAnswers(answers) {
  const asNonNegativeInt = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  };

  const answerItems = (Array.isArray(answers) ? answers : [])
    .map((item) => ({
      text: normalizeInlineText(item?.answer || ''),
      used_paste: item?.used_paste === true,
      paste_count: asNonNegativeInt(item?.paste_count),
      largest_paste_length: asNonNegativeInt(item?.largest_paste_length),
      typed_char_count: asNonNegativeInt(item?.typed_char_count),
      pasted_char_count: asNonNegativeInt(item?.pasted_char_count),
    }))
    .filter((item) => item.text);
  const answerTexts = answerItems.map((item) => item.text);
  if (!answerTexts.length) {
    return {
      ai_aided_risk: 'low',
      ai_aided_risk_reason: 'Insufficient answer text to assess.',
    };
  }

  const normalizeForCompare = (text) => String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const openings = answerTexts
    .map((text) => normalizeForCompare(text).split(' ').slice(0, 4).join(' '))
    .filter(Boolean);
  const openingCounts = new Map();
  for (const opening of openings) openingCounts.set(opening, (openingCounts.get(opening) || 0) + 1);
  const maxOpeningRepeat = Math.max(0, ...Array.from(openingCounts.values()));

  const normalizedAnswers = answerTexts.map(normalizeForCompare).filter(Boolean);
  const hasDuplicateAnswers = new Set(normalizedAnswers).size < normalizedAnswers.length;

  const genericPattern = /\b(firstly|secondly|thirdly|in conclusion|to summarize|in summary|it is important to note|furthermore|moreover|overall)\b/gi;
  let genericHits = 0;
  for (const text of answerTexts) {
    const matches = text.match(genericPattern);
    if (matches) genericHits += matches.length;
  }

  const specificityPattern = /\b(\d+(?:\.\d+)?%?|sql|python|java|javascript|typescript|node|react|aws|gcp|azure|kpi|okr|api|etl|docker|kubernetes|salesforce|tableau|excel|postgres|mysql|redis)\b/gi;
  let lowSpecificVerboseCount = 0;
  for (const text of answerTexts) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 55) continue;
    const specificityHits = (text.match(specificityPattern) || []).length;
    if (specificityHits < 2) lowSpecificVerboseCount += 1;
  }

  const answersWithPaste = answerItems.filter((item) =>
    item.used_paste || item.paste_count > 0 || item.pasted_char_count > 0 || item.largest_paste_length > 0
  );
  const largePasteAnswers = answerItems.filter((item) => item.largest_paste_length >= 120);
  const pasteDominantAnswers = answerItems.filter((item) =>
    item.pasted_char_count >= 120 &&
    item.pasted_char_count > (item.typed_char_count * 1.2)
  );
  const veryLargePasteAnswers = answerItems.filter((item) => item.largest_paste_length >= 240);
  const totalTypedChars = answerItems.reduce((sum, item) => sum + item.typed_char_count, 0);
  const totalPastedChars = answerItems.reduce((sum, item) => sum + item.pasted_char_count, 0);

  let points = 0;
  const signals = [];
  if (hasDuplicateAnswers) {
    points += 3;
    signals.push('multiple answers were near-duplicates');
  }
  if (maxOpeningRepeat >= 3) {
    points += 2;
    signals.push('several answers begin with the same opening phrase');
  } else if (maxOpeningRepeat >= 2 && openings.length >= 3) {
    points += 1;
    signals.push('answers repeatedly start with similar phrasing');
  }
  if (genericHits >= 4) {
    points += 2;
    signals.push('answers repeatedly use generic transition language');
  } else if (genericHits >= 2) {
    points += 1;
    signals.push('answers include repeated generic transition language');
  }
  if (lowSpecificVerboseCount >= 2) {
    points += 2;
    signals.push('long responses include limited role-specific detail');
  } else if (lowSpecificVerboseCount === 1) {
    points += 1;
    signals.push('one long response includes limited role-specific detail');
  }
  if (answersWithPaste.length >= 3) {
    points += 1;
    signals.push('paste was used across multiple answers');
  }
  if (largePasteAnswers.length >= 2) {
    points += 2;
    signals.push('multiple answers include large paste events');
  } else if (largePasteAnswers.length === 1) {
    points += 1;
    signals.push('one answer includes a large paste event');
  }
  if (pasteDominantAnswers.length >= 2) {
    points += 2;
    signals.push('multiple answers are primarily paste-driven');
  } else if (pasteDominantAnswers.length === 1) {
    points += 1;
    signals.push('one answer appears primarily paste-driven');
  }
  if (veryLargePasteAnswers.length >= 1) {
    points += 1;
    signals.push('at least one answer contains a very large pasted block');
  }
  if (
    answerItems.length >= 2 &&
    totalPastedChars >= 320 &&
    totalPastedChars > (totalTypedChars * 1.3)
  ) {
    points += 1;
    signals.push('overall response volume is skewed toward pasted text');
  }

  const ai_aided_risk = points >= 5 ? 'high' : (points >= 3 ? 'medium' : 'low');
  let ai_aided_risk_reason = 'Low observable signs of formulaic or externally generated phrasing.';
  if (signals.length > 0 && ai_aided_risk === 'high') {
    ai_aided_risk_reason = `Higher-risk pattern detected: ${signals.slice(0, 2).join('; ')}.`;
  } else if (signals.length > 0 && ai_aided_risk === 'medium') {
    ai_aided_risk_reason = `Some formulaic-pattern signals detected: ${signals.slice(0, 2).join('; ')}.`;
  } else if (signals.length > 0) {
    ai_aided_risk_reason = `Limited indicators of formulaic phrasing: ${signals[0]}.`;
  }

  return {
    ai_aided_risk,
    ai_aided_risk_reason: ai_aided_risk_reason.slice(0, 300),
  };
}

async function scoreTextInterview({ role, answers }) {
  if (!openai) {
    const err = new Error('OpenAI not configured');
    err.code = 'openai_missing';
    throw err;
  }

  const roleDesc = String(role?.description || role?.job_description_text || '').trim();
  const qa = (answers || [])
    .map((item, idx) => {
      const q = String(item?.question || '').trim();
      const a = String(item?.answer || '').trim();
      return `${idx + 1}. Q: ${q || '[question missing]'}\nA: ${a || '[no answer provided]'}`;
    })
    .join('\n\n');

  const sysPrompt = 'You are an unbiased hiring evaluator. Score the written interview answers against the role criteria. Do not infer protected attributes.';
  const userPrompt = `
Role Title: ${role?.title || '[unknown]'}
Role Description: ${roleDesc || '[none provided]'}

Interview Q&A:
${qa || '[no answers provided]'}

Return strict JSON:
{"interview_score":0-100,"summary":"2-4 sentences explaining strengths/weaknesses against the role."}
`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const parsedInterviewScore = parsed.interview_score ?? parsed.score ?? parsed.total_score;
  const interview_score = Number.isFinite(Number(parsedInterviewScore))
    ? clampScore(parsedInterviewScore)
    : null;
  const summary = String(parsed.summary || '').trim();
  return { interview_score, summary };
}

function getAccommodationResumeBucket() {
  const bucket = String(process.env.SUPABASE_ACCOMMODATION_RESUMES_BUCKET || '').trim();
  if (!bucket) {
    const err = new Error('SUPABASE_ACCOMMODATION_RESUMES_BUCKET not configured');
    err.code = 'bucket_missing';
    err.detail = 'SUPABASE_ACCOMMODATION_RESUMES_BUCKET not configured';
    throw err;
  }
  return bucket;
}

function sendError(res, status, { error, code, detail, hint, request_id }) {
  return res.status(status).json({ error, code, detail, hint, request_id });
}

function logSupabaseError(message, request_id, error) {
  console.error(message, {
    request_id,
    error: error?.message || error,
    detail: error?.detail || null,
    hint: error?.hint || null,
  });
}

function verifyToken(raw) {
  if (!TOKEN_SECRET) {
    const err = new Error('Token secret not configured');
    err.code = 'token_secret_missing';
    throw err;
  }
  const decoded = jwt.verify(raw, TOKEN_SECRET);
  if (!decoded || decoded.mode !== 'text' || !decoded.request_id) {
    const err = new Error('Invalid token');
    err.code = 'token_invalid';
    throw err;
  }
  return decoded;
}

async function loadRequest(requestId) {
  const { data, error } = await supabaseAdmin
    .from('accommodation_requests')
    .select('id, role_id, candidate_id, candidate_name, candidate_email, status, resume_url, resume_received_at, text_completed_at')
    .eq('id', requestId)
    .maybeSingle();
  if (error || !data) {
    const err = new Error('Request not found');
    err.code = 'request_not_found';
    throw err;
  }
  return data;
}

function ensureApprovedStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (!['approved', 'sent'].includes(normalized)) {
    const err = new Error('Request not approved');
    err.code = 'request_not_approved';
    throw err;
  }
}

router.post('/session', async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'text_interview_session');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    const decoded = verifyToken(token);

    const reqRow = await loadRequest(decoded.request_id);
    sentryCandidateId = reqRow.candidate_id || null;
    sentryRoleId = reqRow.role_id || null;
    if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    ensureApprovedStatus(reqRow.status);

    const dup = await checkDuplicateCandidate({
      supabase: supabaseAdmin,
      roleId: reqRow.role_id,
      email: reqRow.candidate_email,
      fullName: reqRow.candidate_name,
      phone: reqRow.candidate_phone,
      excludeCandidateId: reqRow.candidate_id || null,
      allowPhoneEnrich: false,
    });
    if (dup.duplicate) {
      console.warn('[text-interview] duplicate candidate blocked', {
        request_id,
        role_id: reqRow.role_id,
        candidate_id: dup.candidateId || null,
        reason: dup.reason || null,
      });
      return sendError(res, 409, {
        error: 'Already interviewed for this role.',
        code: 'duplicate_candidate',
        detail: dup.reason || null,
        hint: null,
        request_id,
      });
    }

    if (decoded.role_id && decoded.role_id !== reqRow.role_id) {
      return sendError(res, 403, {
        error: 'role_mismatch',
        code: 'role_mismatch',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id, status')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: roleErr?.code || 'role_not_found',
        detail: roleErr?.message || null,
        hint: roleErr?.hint || null,
        request_id,
      });
    }
    sentryClientId = role.client_id || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (!reqRow.text_completed_at && isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'text_interview_session',
        request_id,
        role_id: role.id || reqRow.role_id || null
      });
      return sendError(res, 403, buildRoleInactivePayload(request_id));
    }
    let candidateAssistanceContact = '';
    if (role.client_id) {
      try {
        const { data: client } = await supabaseAdmin
          .from('clients')
          .select('candidate_assistance_contact')
          .eq('id', role.client_id)
          .maybeSingle();
        candidateAssistanceContact = String(client?.candidate_assistance_contact || '').trim();
      } catch {}
    }

    let resumeRequired = !(reqRow.resume_url || reqRow.resume_received_at);
    if (resumeRequired && reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      if (cand?.resume_url) {
        resumeRequired = false;
        await supabaseAdmin
          .from('accommodation_requests')
          .update({ resume_url: cand.resume_url, resume_received_at: new Date().toISOString() })
          .eq('id', reqRow.id);
      }
    }

    const questions = parseQuestions(role.rubric);
    Sentry.addBreadcrumb({
      category: 'text_interview',
      message: 'session loaded',
      level: 'info',
      data: {
        request_id: reqRow.id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });

    return res.json({
      request_id: reqRow.id,
      candidate_name: reqRow.candidate_name,
      candidate_email: reqRow.candidate_email,
      role_id: role.id,
      role_title: role.title || '',
      candidate_assistance_contact: candidateAssistanceContact || null,
      questions,
      resume_required: resumeRequired,
      completed: !!reqRow.text_completed_at,
    });
  } catch (e) {
    let status = 400;
    if (e?.code === 'request_not_approved') status = 403;
    if (e?.code === 'token_secret_missing') status = 500;
    if (status >= 500) {
      Sentry.captureException(e, {
        tags: {
          route_name: 'text_interview_session',
          surface: 'backend',
          request_id: request_id || undefined,
          candidate_id: sentryCandidateId || undefined,
          role_id: sentryRoleId || undefined,
          client_id: sentryClientId || undefined
        },
        extra: {
          request_id,
          candidate_id: sentryCandidateId,
          role_id: sentryRoleId,
          client_id: sentryClientId
        }
      });
    }
    return sendError(res, status, {
      error: e?.message || 'Invalid request',
      code: e?.code || 'invalid_request',
      detail: e?.detail || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

router.post('/resume', upload.any(), async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'text_interview_resume');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    const decoded = verifyToken(token);
    const reqRow = await loadRequest(decoded.request_id);
    sentryCandidateId = reqRow.candidate_id || null;
    sentryRoleId = reqRow.role_id || null;
    if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    ensureApprovedStatus(reqRow.status);

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, client_id, description, job_description_text, status')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: roleErr?.code || 'role_not_found',
        detail: roleErr?.message || null,
        hint: roleErr?.hint || null,
        request_id,
      });
    }
    sentryClientId = role.client_id || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'text_interview_resume',
        request_id,
        role_id: role.id || reqRow.role_id || null
      });
      return sendError(res, 403, buildRoleInactivePayload(request_id));
    }

    const file = (req.files || []).find(f =>
      ['resume', 'resume_file', 'file', 'resumeFile', 'pdf'].includes(f.fieldname)
    );
    if (!file) {
      return sendError(res, 400, {
        error: 'resume_required',
        code: 'resume_required',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const fileType = file.mimetype || 'application/pdf';
    const ext = /pdf/i.test(fileType) ? 'pdf' : 'docx';
    const path = `accommodations/${reqRow.id}.${ext}`;
    let bucket = null;
    try {
      bucket = getAccommodationResumeBucket();
    } catch (e) {
      console.error('[text-interview] resume bucket missing', {
        request_id,
        error: e?.message || e,
        detail: e?.detail || null,
        hint: e?.hint || null,
      });
      return sendError(res, 500, {
        error: e?.code || 'bucket_missing',
        code: e?.code || 'bucket_missing',
        detail: e?.detail || e?.message || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    const up = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, {
      contentType: fileType,
      upsert: true,
    });
    if (up.error) {
      logSupabaseError('[text-interview] resume upload failed', request_id, up.error);
      return sendError(res, 500, {
        error: 'resume_upload_failed',
        code: up.error.code || 'resume_upload_failed',
        detail: up.error.message || null,
        hint: up.error.hint || null,
        request_id,
      });
    }

    const resume_url = path;
    const resume_received_at = new Date().toISOString();

    const { error: updateErr } = await supabaseAdmin
      .from('accommodation_requests')
      .update({ resume_url, resume_received_at })
      .eq('id', reqRow.id);
    if (updateErr) {
      logSupabaseError('[text-interview] resume update failed', request_id, updateErr);
      return sendError(res, 500, {
        error: 'resume_update_failed',
        code: updateErr.code || 'resume_update_failed',
        detail: updateErr.message || null,
        hint: updateErr.hint || null,
        request_id,
      });
    }

    if (reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      if (!cand?.resume_url) {
        const { error: candUpdateErr } = await supabaseAdmin
          .from('candidates')
          .update({ resume_url })
          .eq('id', reqRow.candidate_id);
        if (candUpdateErr) {
          logSupabaseError('[text-interview] candidate resume update failed', request_id, candUpdateErr);
        }
      }
    }

    if (reqRow.candidate_id) {
      const roleForResume = {
        ...role,
        description: role.description || role.job_description_text || ''
      };
      try {
        const analysis = await analyzeResume(file.buffer, fileType, roleForResume, reqRow.candidate_id);
        await supabaseAdmin
          .from('candidates')
          .update({ analysis_summary: analysis })
          .eq('id', reqRow.candidate_id);
        Sentry.addBreadcrumb({
          category: 'text_interview',
          message: 'resume scored',
          level: 'info',
          data: {
            request_id: reqRow.id,
            candidate_id: sentryCandidateId,
            role_id: sentryRoleId,
            client_id: sentryClientId
          }
        });
        console.log('resume_scored', { request_id, candidate_id: reqRow.candidate_id, role_id: reqRow.role_id });
      } catch (e) {
        console.warn('[text-interview] resume scoring failed', { request_id, error: e?.message || e });
      }
    }

    Sentry.addBreadcrumb({
      category: 'text_interview',
      message: 'resume submitted',
      level: 'info',
      data: {
        request_id: reqRow.id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : (e.code === 'openai_missing' ? 500 : 400);
      if (status >= 500) {
        Sentry.captureException(e, {
          tags: {
            route_name: 'text_interview_resume',
            surface: 'backend',
            request_id: request_id || undefined,
            candidate_id: sentryCandidateId || undefined,
            role_id: sentryRoleId || undefined,
            client_id: sentryClientId || undefined
          },
          extra: {
            request_id,
            candidate_id: sentryCandidateId,
            role_id: sentryRoleId,
            client_id: sentryClientId
          }
        });
      }
      return sendError(res, status, {
        error: e?.message || 'Invalid request',
        code: e?.code || 'invalid_request',
        detail: e?.detail || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    console.error('[text-interview] resume upload failed', {
      request_id,
      error: e?.message || e,
      detail: e?.detail || null,
      hint: e?.hint || null,
    });
    Sentry.captureException(e, {
      tags: {
        route_name: 'text_interview_resume',
        surface: 'backend',
        request_id: request_id || undefined,
        candidate_id: sentryCandidateId || undefined,
        role_id: sentryRoleId || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });
    return sendError(res, 500, {
      error: 'resume_upload_failed',
      code: 'resume_upload_failed',
      detail: e?.message || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

router.post('/answers', async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'text_interview_answers');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const token = String(req.body?.token || '').trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!token) {
      return sendError(res, 400, {
        error: 'token_required',
        code: 'token_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    if (!answers || answers.length === 0) {
      return sendError(res, 400, {
        error: 'answers_required',
        code: 'answers_required',
        detail: null,
        hint: null,
        request_id,
      });
    }
    const decoded = verifyToken(token);
    const reqRow = await loadRequest(decoded.request_id);
    sentryCandidateId = reqRow.candidate_id || null;
    sentryRoleId = reqRow.role_id || null;
    if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    ensureApprovedStatus(reqRow.status);

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, rubric, client_id, description, job_description_text, status')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) {
      return sendError(res, 404, {
        error: 'role_not_found',
        code: roleErr?.code || 'role_not_found',
        detail: roleErr?.message || null,
        hint: roleErr?.hint || null,
        request_id,
      });
    }
    sentryClientId = role.client_id || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'text_interview_answers',
        request_id,
        role_id: role.id || reqRow.role_id || null
      });
      return sendError(res, 403, buildRoleInactivePayload(request_id));
    }

    let resumePresent = !!(reqRow.resume_url || reqRow.resume_received_at);
    let candidateResumeUrl = null;
    if (!resumePresent && reqRow.candidate_id) {
      const { data: cand } = await supabaseAdmin
        .from('candidates')
        .select('resume_url')
        .eq('id', reqRow.candidate_id)
        .maybeSingle();
      candidateResumeUrl = cand?.resume_url || null;
      resumePresent = !!candidateResumeUrl;
    }
    if (resumePresent && candidateResumeUrl && !(reqRow.resume_url || reqRow.resume_received_at)) {
      await supabaseAdmin
        .from('accommodation_requests')
        .update({ resume_url: candidateResumeUrl, resume_received_at: new Date().toISOString() })
        .eq('id', reqRow.id);
    }
    if (!resumePresent) {
      return sendError(res, 400, {
        error: 'resume_required',
        code: 'resume_required',
        detail: null,
        hint: null,
        request_id,
      });
    }

    const rubricQuestions = parseQuestions(role.rubric);

    const firstSubmit = !reqRow.text_completed_at;

    await supabaseAdmin
      .from('accommodation_requests')
      .update({ text_answers: answers })
      .eq('id', reqRow.id);
    Sentry.addBreadcrumb({
      category: 'text_interview',
      message: 'answers submitted',
      level: 'info',
      data: {
        request_id: reqRow.id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });

    if (firstSubmit && reqRow.candidate_id) {
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null,
        remainingInterviews: availability.remaining_interviews,
        roleTitle: role.title || ''
      });
      if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
        return sendError(res, 403, {
          error: 'interview_limit_reached',
          code: 'interview_limit_reached',
          detail: 'This role has no interviews remaining under the current plan.',
          hint: null,
          request_id,
        });
      }

      const scoring = await scoreTextInterview({ role, answers });
      const summaryNote = scoring.summary
        ? `${TEXT_COMPLETION_NOTE} ${scoring.summary}`.trim()
        : TEXT_COMPLETION_NOTE;

      const { data: latestReport } = await supabaseAdmin
        .from('reports')
        .select('id, resume_score, resume_breakdown, analysis')
        .eq('candidate_id', reqRow.candidate_id)
        .eq('role_id', role.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let resumeScore = toScoreOrNull(latestReport?.resume_score);
      let resumeBreakdown = latestReport?.resume_breakdown || null;

      if (resumeScore == null) {
        const { data: cand } = await supabaseAdmin
          .from('candidates')
          .select('analysis_summary')
          .eq('id', reqRow.candidate_id)
          .maybeSingle();
        const candResume = cand?.analysis_summary || null;
        resumeScore = toScoreOrNull(candResume?.resume_score);
        if (!resumeBreakdown && candResume) resumeBreakdown = candResume;
      }

      const interviewScore = Number.isFinite(Number(scoring.interview_score))
        ? clampScore(scoring.interview_score)
        : null;
      const overallScore = (resumeScore != null && interviewScore != null)
        ? clampScore((resumeScore + interviewScore) / 2)
        : null;
      const aiRisk = assessAiAidedRiskFromAnswers(answers);
      const transcript = buildTextInterviewTranscript(answers, rubricQuestions);
      const unansweredCandidateQuestions = getUnansweredCandidateQuestions({ rubricQuestions, answers });
      const transcriptScores = {
        overall: interviewScore,
        confidence: null,
        ai_aided_risk: aiRisk.ai_aided_risk,
        ai_aided_risk_reason: aiRisk.ai_aided_risk_reason,
      };
      const perceptionScores = {
        mode: 'text',
        unavailable: true,
        reason: 'Perception analysis is not available for text interviews.',
      };

      const interview_breakdown = {
        clarity: null,
        confidence: null,
        body_language: null,
        ai_aided_risk: transcriptScores.ai_aided_risk,
        ai_aided_risk_reason: transcriptScores.ai_aided_risk_reason,
        summary: summaryNote,
      };

      const interviewAnalysis = {
        mode: 'text',
        summary: summaryNote,
        scores: {
          interview_score: interviewScore,
          clarity: null,
          confidence: null,
          body_language: null,
          overall: interviewScore,
          ai_aided_risk: transcriptScores.ai_aided_risk,
          ai_aided_risk_reason: transcriptScores.ai_aided_risk_reason,
        },
        transcript_scores: transcriptScores,
        perception_scores: perceptionScores,
        unanswered_candidate_questions: unansweredCandidateQuestions,
        answers,
      };

      // The id is read back so the interview can be charged to a credit at most
      // once, however many times this path is retried.
      const { data: insertedInterview } = await supabaseAdmin.from('interviews').insert({
        candidate_id: reqRow.candidate_id,
        role_id: role.id,
        client_id: role.client_id || null,
        rubric: role.rubric || null,
        transcript,
        transcript_scores: transcriptScores,
        interview_summary: summaryNote,
        perception_scores: perceptionScores,
        unanswered_candidate_questions: unansweredCandidateQuestions,
        analysis: interviewAnalysis,
        status: 'completed',
      }).select('id').maybeSingle();
      const postInsertAvailability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null
      });
      // A text interview is complete the moment it is inserted, so this is where
      // it draws a credit if the role's own allowance is already spent.
      const creditDraw = await syncInterviewCreditDraw({
        db: supabaseAdmin,
        clientId: role.client_id || null,
        roleId: role.id,
        interviewId: insertedInterview?.id || null,
        availability: postInsertAvailability
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId: role.id,
        clientId: role.client_id || null,
        remainingInterviews: creditDraw.remaining_interviews,
        roleTitle: role.title || ''
      });

      if (latestReport?.id) {
        const reportAnalysis = {
          ...(latestReport.analysis || {}),
          mode: 'text',
          summary: summaryNote,
          interview_score: interviewScore,
          ai_aided_risk: transcriptScores.ai_aided_risk,
          ai_aided_risk_reason: transcriptScores.ai_aided_risk_reason,
        };
        await supabaseAdmin
          .from('reports')
          .update({
            interview_score: interviewScore,
            overall_score: overallScore,
            interview_breakdown,
            analysis: reportAnalysis,
          })
          .eq('id', latestReport.id);
      } else {
        await supabaseAdmin.from('reports').insert({
          candidate_id: reqRow.candidate_id,
          role_id: role.id,
          client_id: role.client_id || null,
          resume_score: resumeScore,
          resume_breakdown: resumeBreakdown,
          interview_score: interviewScore,
          overall_score: overallScore,
          interview_breakdown,
          analysis: {
            summary: summaryNote,
            mode: 'text',
            interview_score: interviewScore,
            ai_aided_risk: transcriptScores.ai_aided_risk,
            ai_aided_risk_reason: transcriptScores.ai_aided_risk_reason,
          },
        });
      }

      await supabaseAdmin
        .from('accommodation_requests')
        .update({ text_completed_at: new Date().toISOString() })
        .eq('id', reqRow.id);

      await supabaseAdmin
        .from('candidates')
        .update({ status: 'Interview Completed (Text)', interview_status: 'Interview Completed (Text)' })
        .eq('id', reqRow.candidate_id);

      console.log('text_interview_scored', {
        request_id,
        candidate_id: reqRow.candidate_id,
        role_id: role.id,
        interview_score: interviewScore,
        overall_score: overallScore,
      });
      Sentry.addBreadcrumb({
        category: 'text_interview',
        message: 'answers scored',
        level: 'info',
        data: {
          request_id: reqRow.id,
          candidate_id: sentryCandidateId,
          role_id: sentryRoleId,
          client_id: sentryClientId
        }
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    if (e?.code) {
      const status = e.code === 'request_not_approved' ? 403 : 400;
      return sendError(res, status, {
        error: e?.message || 'Invalid request',
        code: e?.code || 'invalid_request',
        detail: e?.detail || null,
        hint: e?.hint || null,
        request_id,
      });
    }
    console.error('[text-interview] answers failed', {
      request_id,
      error: e?.message || e,
      detail: e?.detail || null,
      hint: e?.hint || null,
    });
    Sentry.captureException(e, {
      tags: {
        route_name: 'text_interview_answers',
        surface: 'backend',
        request_id: request_id || undefined,
        candidate_id: sentryCandidateId || undefined,
        role_id: sentryRoleId || undefined,
        client_id: sentryClientId || undefined
      },
      extra: {
        request_id,
        candidate_id: sentryCandidateId,
        role_id: sentryRoleId,
        client_id: sentryClientId
      }
    });
    return sendError(res, 500, {
      error: 'submission_failed',
      code: 'submission_failed',
      detail: e?.message || null,
      hint: e?.hint || null,
      request_id,
    });
  }
});

module.exports = router;

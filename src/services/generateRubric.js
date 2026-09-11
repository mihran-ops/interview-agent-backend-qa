// generateRubric.js
'use strict'

const OpenAI = require('openai')
const { randomUUID } = require('crypto')
const path = require('path')
const { parseBufferToText } = require('../render/jdParser')
const { ensureTavusDocumentForRole } = require('./tavusDocuments')
const { getPlanCapacity, normalizeMembershipLevel, requirePlanCapacity, resolvePlanCapacityForClient } = require('./planCapacity')
const { getInterviewTypeConfig, normalizeInterviewType, requireInterviewType } = require('./interviewTypes')

const { supabaseAdmin: supabase } = require('../clients/supabase')
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const REQUIRED_QUESTION_FIELDS = Object.freeze([
  'text',
  'primary_competency',
  'why_it_matters',
  'expected_evidence',
  'role_relevance'
])
const REQUIRED_SCORING_ANCHORS = Object.freeze(['weak', 'adequate', 'strong', 'exceptional'])
const GENERIC_FILLER_PATTERNS = Object.freeze([
  /^tell me about yourself[?.!]*$/i,
  /^what are your strengths[?.!]*$/i,
  /^what are your weaknesses[?.!]*$/i,
  /^where do you see yourself in (?:five|5) years[?.!]*$/i,
])
const PROHIBITED_QUESTION_PATTERNS = Object.freeze([
  /\b(?:age|date of birth|marital status|pregnan|disabilit|medical condition|religion|political affiliation|race|ethnicity|sexual orientation|gender identity)\b/i,
  /\b(?:confidential|proprietary|trade secret|non[- ]public)\b.*\b(?:employer|company|client|information|data)\b/i,
])

class RubricQuestionQualityError extends Error {
  constructor({ target, validQuestionCount, errors = [] }) {
    super(`Generated rubric failed the exact ${target}-question canonical quality contract.`)
    this.name = 'RubricQuestionQualityError'
    this.code = 'RUBRIC_QUESTION_QUALITY_FAILED'
    this.stage = 'rubric_quality'
    this.status = 502
    this.detail = {
      minimum: target,
      maximum: target,
      target,
      valid_question_count: validQuestionCount,
      errors: Array.isArray(errors) ? errors.slice(0, 20) : [],
      attempts: 2
    }
  }
}

function splitBucketAndKey(full) {
  if (!full || typeof full !== 'string') return { bucket: null, key: null }
  const idx = full.indexOf('/')
  if (idx === -1) return { bucket: full, key: '' }
  return { bucket: full.slice(0, idx), key: full.slice(idx + 1) }
}

async function downloadAsBuffer(bucket, key) {
  const { data, error } = await supabase.storage.from(bucket).download(key)
  if (error) throw new Error(`storage_download_failed: ${error.message}`)
  const ab = await data.arrayBuffer()
  return Buffer.from(ab)
}

function guessMimeFromExt(filename) {
  const ext = (path.extname(filename || '').toLowerCase() || '').replace('.', '')
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/octet-stream'
}

function safeJSONParse(value) {
  try { return JSON.parse(value) } catch { return null }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeQuestionKey(value) {
  return cleanText(value).toLowerCase()
}

function normalizeScoringGuidance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  for (const anchor of REQUIRED_SCORING_ANCHORS) out[anchor] = cleanText(value[anchor])
  return out
}

function normalizeRubricQuestions(questions) {
  const seenText = new Set()
  const normalized = []

  for (const [index, question] of (Array.isArray(questions) ? questions : []).entries()) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) continue
    const text = cleanText(question.text)
    if (!text) continue
    const key = normalizeQuestionKey(text)
    if (seenText.has(key)) continue
    seenText.add(key)
    const primaryCompetency = cleanText(question.primary_competency || question.competency || question.category)
    normalized.push({
      ...question,
      text,
      category: cleanText(question.category || primaryCompetency),
      primary_competency: primaryCompetency,
      why_it_matters: cleanText(question.why_it_matters || question.reason_for_inclusion),
      expected_evidence: cleanText(question.expected_evidence),
      scoring_guidance: normalizeScoringGuidance(question.scoring_guidance || question.scoring_anchors),
      role_relevance: cleanText(question.role_relevance),
      question_order: index + 1,
    })
  }
  return normalized
}

function generationContext(role, membershipLevel) {
  const normalizedMembership = normalizeMembershipLevel(membershipLevel || role?.membership_level || role?.plan_tier)
  const planCapacity = requirePlanCapacity(normalizedMembership)
  const interviewType = requireInterviewType(role?.interview_type || 'core')
  const typeConfig = getInterviewTypeConfig(interviewType)
  return { membershipLevel: normalizedMembership, planCapacity, interviewType, typeConfig }
}

function coerceGeneratedRubric(value) {
  const rubric = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  // Preserve generated top-level metadata so validation can reject missing,
  // mismatched, or legacy values instead of silently stamping them as valid.
  return {
    ...rubric,
    membership_level: cleanText(rubric.membership_level).toLowerCase(),
    interview_type: cleanText(rubric.interview_type).toLowerCase(),
    questions: normalizeRubricQuestions(rubric.questions),
  }
}

function validateRubric(rubric, { membershipLevel, interviewType } = {}) {
  const capacity = getPlanCapacity(membershipLevel)
  const canonicalType = normalizeInterviewType(interviewType)
  const typeConfig = getInterviewTypeConfig(canonicalType)
  const errors = []
  const questions = normalizeRubricQuestions(rubric?.questions)
  if (!capacity) errors.push('invalid_membership_level')
  if (!canonicalType) errors.push('invalid_interview_type')
  if (capacity && rubric?.membership_level !== capacity.membership_level) errors.push('incorrect_membership_level')
  if (rubric?.interview_type !== canonicalType) errors.push('noncanonical_interview_type')
  if (capacity && questions.length !== capacity.scored_question_count) {
    errors.push(`wrong_question_count:${questions.length}`)
  }

  const competencyKeys = new Set()
  questions.forEach((question, index) => {
    for (const field of REQUIRED_QUESTION_FIELDS) {
      if (!cleanText(question[field])) errors.push(`question_${index + 1}_missing_${field}`)
    }
    const competencyKey = normalizeQuestionKey(question.primary_competency)
    if (competencyKey) {
      if (competencyKeys.has(competencyKey)) errors.push(`question_${index + 1}_duplicate_competency`)
      competencyKeys.add(competencyKey)
    }
    if (GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(question.text))) {
      errors.push(`question_${index + 1}_generic_filler`)
    }
    if (PROHIBITED_QUESTION_PATTERNS.some((pattern) => pattern.test(question.text))) {
      errors.push(`question_${index + 1}_prohibited_content`)
    }
    const expectedCompetency = typeConfig?.blueprint?.[index]?.primary_competency || ''
    if (expectedCompetency && normalizeQuestionKey(question.primary_competency) !== normalizeQuestionKey(expectedCompetency)) {
      errors.push(`question_${index + 1}_wrong_type_competency`)
    }
    if (!question.scoring_guidance) {
      errors.push(`question_${index + 1}_missing_scoring_guidance`)
    } else {
      for (const anchor of REQUIRED_SCORING_ANCHORS) {
        if (!cleanText(question.scoring_guidance[anchor])) {
          errors.push(`question_${index + 1}_missing_scoring_${anchor}`)
        }
      }
    }
  })

  return { ok: errors.length === 0, errors, questions }
}

function buildRubricPrompt(role, jdText, membershipLevel) {
  const context = generationContext(role, membershipLevel)
  const blueprint = context.typeConfig.blueprint.slice(0, context.planCapacity.scored_question_count)
  return `You are an AI interview designer. Create a role-specific scored interview rubric.

Return ONLY valid JSON using this exact shape:
{
  "membership_level": "${context.membershipLevel}",
  "interview_type": "${context.interviewType}",
  "questions": [
    {
      "text": "one open-ended scored question",
      "category": "schema-compatible category",
      "primary_competency": "one competency",
      "why_it_matters": "specific reason this is useful for the role",
      "expected_evidence": "concrete evidence or reasoning expected",
      "scoring_guidance": {
        "weak": "weak evidence anchor",
        "adequate": "adequate evidence anchor",
        "strong": "strong evidence anchor",
        "exceptional": "exceptional evidence anchor"
      },
      "role_relevance": "how the question connects to this role",
      "question_order": 1
    }
  ]
}

Membership contract:
- Membership: ${context.planCapacity.display_name}
- Candidate-visible duration: ${context.planCapacity.interview_duration_minutes} minutes, including the introduction and unscored warm-up.
- Return exactly ${context.planCapacity.scored_question_count} scored questions. The warm-up is not part of this rubric.

Interview-type contract:
- Canonical type: ${context.interviewType}
- Purpose: ${context.typeConfig.purpose}
- Scoring emphasis: ${context.typeConfig.scoring_emphasis.join('; ')}
- Type controls content and scoring only. It does not control time or question quantity.
- Core is appropriate for senior individual contributors and does not mean entry-level.
- Technical questions must fit the actual profession and must not default non-software roles to software-engineering questions.

Use these competencies in this exact order, one per question:
${blueprint.map((item, index) => `${index + 1}. ${item.primary_competency}: ${item.guidance}`).join('\n')}

Quality rules:
- Request a concrete example, applied judgment, or explicit reasoning.
- Ask one clear primary question without unnecessary multi-part wording.
- Make every question relevant to the role title, job description, seniority, responsibilities, and client priorities.
- Do not duplicate a primary competency or the evidence requested by another question.
- Do not ask about protected status, health, family, religion, politics, or confidential prior-employer information.
- Do not ask generic filler such as “Tell me about yourself,” strengths, weaknesses, or five-year plans.
- Use normal conversational language and keep the set answerable within ${context.planCapacity.interview_duration_minutes} minutes.
- Scoring anchors must distinguish weak, adequate, strong, and exceptional evidence on the current 0-100 scoring representation without changing that global scale.

Role title: ${cleanText(role?.title) || 'Unspecified role'}
Job description:
${String(jdText || 'N/A').trim() || 'N/A'}

Client-provided manual questions or priorities:
${Array.isArray(role?.manual_questions) ? JSON.stringify(role.manual_questions) : String(role?.manual_questions || 'None')}`
}

function buildRubricCorrectionPrompt(role, jdText, membershipLevel, priorRubric, errors) {
  return `${buildRubricPrompt(role, jdText, membershipLevel)}

QUALITY CORRECTION:
The prior output was rejected by deterministic validation.
Validation errors: ${JSON.stringify(errors)}
Return a complete replacement rubric. Do not preserve invalid or duplicate questions.
Rejected output: ${JSON.stringify(priorRubric)}`
}

async function requestRubric({ prompt, openaiClient = openai, logger = console }) {
  try {
    const resp = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_RUBRIC_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
    const raw = resp?.choices?.[0]?.message?.content || ''
    const rubricObj = safeJSONParse(raw)
    return rubricObj && Array.isArray(rubricObj.questions) ? rubricObj : null
  } catch (error) {
    logger.error('openai_rubric_failed:', error?.message || error)
    return null
  }
}

const FALLBACK_QUESTION_TEXT = Object.freeze({
  core: Object.freeze([
    (role) => `Describe a concrete example from your experience that best demonstrates your readiness to succeed as a ${role}.`,
    (role) => `Imagine you encounter an unexpected problem while working as a ${role}. How would you assess the situation and decide what to do?`,
    (role) => `Describe a time you took ownership of an important commitment and ensured it was completed reliably.`,
    (role) => `Describe a disagreement with a colleague or stakeholder and explain how you communicated and worked toward a productive outcome.`,
    (role) => `Tell me about a time expectations or customer needs changed quickly. How did you adapt while maintaining effective work?`,
    (role) => `Walk me through how you would prioritize competing responsibilities and maintain quality in the ${role} role.`,
    (role) => `Describe a setback or changing expectation that required you to learn and improve. What changed in your approach?`,
  ]),
  leadership: Object.freeze([
    (role) => `Describe the scope of a team or function you led and a concrete example of the results you helped it achieve as a ${role}.`,
    () => `Describe a time you coached someone whose performance needed to improve. What did you do, and what evidence showed the outcome?`,
    () => `Tell me about a time you had to address missed expectations or deliver difficult feedback. How did you maintain accountability?`,
    (role) => `Walk me through a consequential decision you made under competing demands in a ${role} context and how you prioritized.`,
    () => `Describe a difficult conflict, change, or cross-functional effort you led. How did you influence progress and results?`,
    () => `Describe how you used metrics and stakeholder alignment to sustain an operational improvement.`,
    () => `Tell me about a high-stakes delegation, talent, hiring, crisis, or organizational decision and the evidence behind your judgment.`,
  ]),
  technical: Object.freeze([
    (role) => `Describe hands-on technical work that best demonstrates your readiness for the ${role} role, including what you personally did.`,
    (role) => `Walk me through how you would apply the core technical practices of a ${role} to a realistic but unfamiliar assignment.`,
    (role) => `Describe a difficult problem you diagnosed in your field. How did you isolate the root cause and verify the resolution?`,
    (role) => `Tell me about a technical tradeoff or risk decision relevant to ${role} work and explain the evidence behind your choice.`,
    (role) => `How do you validate quality, safety, compliance, or technical communication in ${role} work? Give a concrete example.`,
    (role) => `Describe an implementation or workflow in ${role} work where interactions between components, people, or process required deeper technical judgment.`,
    (role) => `Describe a high-risk edge case or failure scenario relevant to ${role} work. How would you detect, contain, and resolve it?`,
  ]),
})

function scoringGuidance(primaryCompetency) {
  return {
    weak: `Provides little relevant evidence or reasoning for ${primaryCompetency}; claims are vague or unsupported.`,
    adequate: `Provides a relevant example or approach for ${primaryCompetency} with understandable but limited evidence.`,
    strong: `Provides specific, role-relevant evidence for ${primaryCompetency}, sound reasoning, and a clear outcome or validation method.`,
    exceptional: `Provides unusually precise and transferable evidence for ${primaryCompetency}, anticipates tradeoffs or risks, and demonstrates measurable impact or learning.`,
  }
}

function buildFallbackRubric(role, membershipLevel) {
  const context = generationContext(role, membershipLevel)
  const roleTitle = cleanText(role?.title) || 'this role'
  const questions = context.typeConfig.blueprint
    .slice(0, context.planCapacity.scored_question_count)
    .map((blueprintItem, index) => ({
      text: FALLBACK_QUESTION_TEXT[context.interviewType][index](roleTitle),
      category: blueprintItem.primary_competency,
      primary_competency: blueprintItem.primary_competency,
      why_it_matters: `This assesses ${blueprintItem.primary_competency} because it is part of successful ${roleTitle} performance.`,
      expected_evidence: `${blueprintItem.guidance} The answer should include concrete actions, reasoning, and an outcome or validation method.`,
      scoring_guidance: scoringGuidance(blueprintItem.primary_competency),
      role_relevance: `Directly adapted to the responsibilities and decisions expected of a ${roleTitle}.`,
      question_order: index + 1,
    }))
  return {
    membership_level: context.membershipLevel,
    interview_type: context.interviewType,
    questions,
  }
}

async function generateRubricForRole({ role, jdText, membershipLevel, openaiClient = openai, logger = console }) {
  const context = generationContext(role, membershipLevel)
  const rubricObj = await requestRubric({
    prompt: buildRubricPrompt(role, jdText, context.membershipLevel),
    openaiClient,
    logger
  })
  return rubricObj
    ? coerceGeneratedRubric(rubricObj)
    : buildFallbackRubric(role, context.membershipLevel)
}

async function generateReplacementRubric({ role, jdText, membershipLevel, openaiClient = openai, logger = console }) {
  const context = generationContext(role, membershipLevel)
  const initialRubric = await generateRubricForRole({
    role,
    jdText,
    membershipLevel: context.membershipLevel,
    openaiClient,
    logger,
  })
  const initialValidation = validateRubric(initialRubric, {
    membershipLevel: context.membershipLevel,
    interviewType: context.interviewType,
  })
  if (initialValidation.ok) return { ...initialRubric, questions: initialValidation.questions }

  const retryRubricRaw = await requestRubric({
    prompt: buildRubricCorrectionPrompt(
      role,
      jdText,
      context.membershipLevel,
      initialRubric,
      initialValidation.errors,
    ),
    openaiClient,
    logger,
  })
  const retryRubric = coerceGeneratedRubric(retryRubricRaw)
  const retryValidation = validateRubric(retryRubric, {
    membershipLevel: context.membershipLevel,
    interviewType: context.interviewType,
  })
  if (!retryValidation.ok) {
    throw new RubricQuestionQualityError({
      target: context.planCapacity.scored_question_count,
      validQuestionCount: retryValidation.questions.length,
      errors: retryValidation.errors,
    })
  }
  return { ...retryRubric, questions: retryValidation.questions }
}

function makeKBFromRubric(rubricObj) {
  const questions = (Array.isArray(rubricObj?.questions) ? rubricObj.questions : [])
    .map((question) => ({ text: cleanText(question?.text) }))
    .filter((question) => question.text)
  return { questions }
}

async function uploadKnowledgeBase({ rubricObj, supabaseClient = supabase, kbId = randomUUID() }) {
  const kbJson = makeKBFromRubric(rubricObj)
  const kbKey = `${kbId}.json`
  const { error: upErr } = await supabaseClient.storage
    .from('kbs')
    .upload(kbKey, new Blob([JSON.stringify(kbJson, null, 2)], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true
    })
  if (upErr) {
    const { error: upErr2 } = await supabaseClient.storage
      .from('kbs')
      .upload(kbKey, Buffer.from(JSON.stringify(kbJson)), {
        contentType: 'application/json',
        upsert: true
      })
    if (upErr2) throw new Error(`kb_upload_failed: ${upErr2.message}`)
  }
  return kbId
}

async function resolveMembershipLevelForRole(role, { membershipLevel, supabaseClient = supabase } = {}) {
  const explicit = normalizeMembershipLevel(membershipLevel || role?.membership_level || role?.plan_tier)
  if (explicit) return explicit
  const clientId = cleanText(role?.client_id)
  if (!clientId) {
    const error = new Error('role_membership_level_required')
    error.code = 'ROLE_MEMBERSHIP_LEVEL_REQUIRED'
    throw error
  }
  try {
    return (await resolvePlanCapacityForClient({ db: supabaseClient, clientId })).membership_level
  } catch (error) {
    if (error?.code === 'PLAN_CAPACITY_LOOKUP_FAILED') {
      throw new Error('plan_settings_lookup_failed')
    }
    const missing = new Error('role_membership_level_required')
    missing.code = 'ROLE_MEMBERSHIP_LEVEL_REQUIRED'
    throw missing
  }
}

async function generateJdDerivedArtifactsForRole(
  { role, jdText },
  { supabaseClient = supabase, openaiClient = openai, logger = console, kbId, membershipLevel } = {}
) {
  if (!role?.id) throw new Error('role_id_required')
  const normalizedJdText = String(jdText || '').trim()
  const resolvedMembership = await resolveMembershipLevelForRole(role, { membershipLevel, supabaseClient })
  const rubric = await generateReplacementRubric({
    role,
    jdText: normalizedJdText,
    membershipLevel: resolvedMembership,
    openaiClient,
    logger
  })
  const kbDocumentId = await uploadKnowledgeBase({ rubricObj: rubric, supabaseClient, kbId })
  const rubricQuestions = rubric.questions
  const description = normalizedJdText ? normalizedJdText.replace(/\s+/g, ' ').slice(0, 400) : null
  return {
    job_description_text: normalizedJdText,
    description,
    rubric,
    rubric_questions: rubricQuestions,
    kb_document_id: kbDocumentId
  }
}

async function generateRubricAndKBForRole(roleId) {
  const { data: role, error: roleErr } = await supabase
    .from('roles')
    .select('id, client_id, title, interview_type, manual_questions, job_description_url')
    .eq('id', roleId)
    .single()
  if (roleErr || !role) throw new Error(`role_lookup_failed: ${roleErr?.message || 'not found'}`)

  const membershipLevel = await resolveMembershipLevelForRole(role, { supabaseClient: supabase })
  let jdText = ''
  if (role.job_description_url) {
    const { bucket, key } = splitBucketAndKey(role.job_description_url)
    if (bucket && key) {
      const buf = await downloadAsBuffer(bucket, key)
      jdText = await parseBufferToText(buf, guessMimeFromExt(key), key)
    }
  }

  const rubric = await generateReplacementRubric({ role, jdText, membershipLevel })
  const rubricQuestions = rubric.questions
  const descriptionExcerpt = jdText ? jdText.replace(/\s+/g, ' ').trim().slice(0, 400) : ''
  await supabase.from('roles').update({
    rubric,
    rubric_questions: rubricQuestions,
    interview_type: rubric.interview_type,
    ...(jdText ? { job_description_text: jdText, description: descriptionExcerpt || null } : {})
  }).eq('id', roleId)

  const kbDocumentId = await uploadKnowledgeBase({ rubricObj: rubric })
  const { error: updErr } = await supabase
    .from('roles')
    .update({ kb_document_id: kbDocumentId })
    .eq('id', roleId)
  if (updErr) throw new Error(`kb_id_update_failed: ${updErr.message}`)

  try {
    await ensureTavusDocumentForRole(
      { id: roleId, title: role.title, kb_document_id: kbDocumentId },
      { supabase, rubric }
    )
  } catch (tavusErr) {
    console.error(
      `[generateRubric] tavus_document_creation_failed role=${roleId} kb_document_id=${kbDocumentId}:`,
      tavusErr?.message || tavusErr
    )
  }

  return { role_id: roleId, kb_document_id: kbDocumentId }
}

module.exports = {
  GENERIC_FILLER_PATTERNS,
  PROHIBITED_QUESTION_PATTERNS,
  RubricQuestionQualityError,
  buildFallbackRubric,
  buildRubricCorrectionPrompt,
  buildRubricPrompt,
  generateJdDerivedArtifactsForRole,
  generateReplacementRubric,
  generateRubricAndKBForRole,
  generateRubricForRole,
  makeKBFromRubric,
  normalizeRubricQuestions,
  resolveMembershipLevelForRole,
  validateRubric,
}

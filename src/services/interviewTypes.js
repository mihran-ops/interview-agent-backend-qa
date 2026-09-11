'use strict';

const INTERVIEW_TYPE_ALIASES = Object.freeze({
  basic: 'core',
  core: 'core',
  detailed: 'leadership',
  leadership: 'leadership',
  technical: 'technical',
});

const INTERVIEW_TYPE_CONFIG = Object.freeze({
  core: Object.freeze({
    canonical_name: 'core',
    display_name: 'Core',
    purpose: 'Broad role-relevant screening of experience, judgment, ownership, reliability, communication, collaboration, adaptability, and readiness. Core does not mean entry-level.',
    scoring_emphasis: Object.freeze([
      'relevant experience',
      'judgment and problem-solving',
      'ownership and reliability',
      'communication and collaboration',
      'adaptability and role readiness',
    ]),
    blueprint: Object.freeze([
      Object.freeze({ primary_competency: 'relevant experience', guidance: 'Relevant experience demonstrated through a concrete role-related example.' }),
      Object.freeze({ primary_competency: 'judgment and problem-solving', guidance: 'Judgment or problem-solving in a realistic role-related situation.' }),
      Object.freeze({ primary_competency: 'ownership and reliability', guidance: 'Ownership, reliability, or follow-through supported by evidence.' }),
      Object.freeze({ primary_competency: 'communication and collaboration', guidance: 'Collaboration, communication, or handling disagreement.' }),
      Object.freeze({ primary_competency: 'adaptability and role readiness', guidance: 'Adaptability, customer orientation, or work-readiness scenario.' }),
      Object.freeze({ primary_competency: 'role-specific execution and prioritization', guidance: 'Role-specific execution, quality, or prioritization scenario.' }),
      Object.freeze({ primary_competency: 'learning and resilience', guidance: 'Learning, improvement, resilience, or changing expectations.' }),
    ]),
  }),
  leadership: Object.freeze({
    canonical_name: 'leadership',
    display_name: 'Leadership',
    purpose: 'Leadership and management assessment of coaching, accountability, difficult feedback, prioritization, decision-making, conflict, change, delegation, and execution.',
    scoring_emphasis: Object.freeze([
      'leadership judgment',
      'coaching and development',
      'accountability',
      'decision-making',
      'execution and prioritization',
      'communication and influence',
      'change or conflict leadership',
    ]),
    blueprint: Object.freeze([
      Object.freeze({ primary_competency: 'leadership scope and results', guidance: 'Leadership scope and a concrete example of driving results.' }),
      Object.freeze({ primary_competency: 'coaching and development', guidance: 'Coaching or improving an employee’s performance.' }),
      Object.freeze({ primary_competency: 'accountability and difficult feedback', guidance: 'Accountability, difficult feedback, or addressing missed expectations.' }),
      Object.freeze({ primary_competency: 'decision-making and prioritization', guidance: 'Decision-making and prioritization under competing demands.' }),
      Object.freeze({ primary_competency: 'conflict and change leadership', guidance: 'Conflict, change, or difficult cross-functional execution.' }),
      Object.freeze({ primary_competency: 'operational execution and stakeholder alignment', guidance: 'Metrics, operational execution, stakeholder alignment, or sustained improvement.' }),
      Object.freeze({ primary_competency: 'delegation and talent leadership', guidance: 'Delegation, talent development, hiring judgment, crisis leadership, or organizational design.' }),
    ]),
  }),
  technical: Object.freeze({
    canonical_name: 'technical',
    display_name: 'Technical',
    purpose: 'Role-specific applied assessment of technical knowledge, hands-on experience, troubleshooting, diagnosis, implementation, tradeoffs, quality, risk, compliance, and technical communication.',
    scoring_emphasis: Object.freeze([
      'technical accuracy',
      'applied knowledge',
      'troubleshooting and diagnosis',
      'tradeoff and risk awareness',
      'quality and compliance',
      'implementation depth',
      'technical communication',
    ]),
    blueprint: Object.freeze([
      Object.freeze({ primary_competency: 'hands-on technical experience', guidance: 'Relevant hands-on technical experience for the actual profession.' }),
      Object.freeze({ primary_competency: 'applied technical judgment', guidance: 'Applied role-specific technical scenario.' }),
      Object.freeze({ primary_competency: 'troubleshooting and diagnosis', guidance: 'Troubleshooting, diagnosis, or root-cause analysis.' }),
      Object.freeze({ primary_competency: 'technical tradeoffs and risk', guidance: 'Technical tradeoff, design choice, or risk decision.' }),
      Object.freeze({ primary_competency: 'quality and compliance', guidance: 'Quality, safety, compliance, validation, or technical communication.' }),
      Object.freeze({ primary_competency: 'implementation depth', guidance: 'Implementation depth, system interaction, workflow design, or advanced execution.' }),
      Object.freeze({ primary_competency: 'edge-case and failure judgment', guidance: 'Advanced edge case, scalability concern, failure scenario, or high-risk judgment.' }),
    ]),
  }),
});

const CANONICAL_INTERVIEW_TYPES = Object.freeze(Object.keys(INTERVIEW_TYPE_CONFIG));

function normalizeInterviewType(value, { fallback = null } = {}) {
  const normalized = String(value || '').trim().toLowerCase();
  const canonical = INTERVIEW_TYPE_ALIASES[normalized] || null;
  if (canonical) return canonical;
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  return INTERVIEW_TYPE_CONFIG[normalizedFallback] ? normalizedFallback : null;
}

function requireInterviewType(value) {
  const canonical = normalizeInterviewType(value);
  if (!canonical) {
    const error = new Error('Interview type must be Core, Leadership, or Technical.');
    error.code = 'INVALID_INTERVIEW_TYPE';
    error.status = 400;
    throw error;
  }
  return canonical;
}

function getInterviewTypeConfig(value) {
  const canonical = normalizeInterviewType(value);
  return canonical ? INTERVIEW_TYPE_CONFIG[canonical] : null;
}

function normalizeRoleInterviewTypeForRead(role) {
  if (!role || typeof role !== 'object' || Array.isArray(role)) return role;
  return {
    ...role,
    interview_type: normalizeInterviewType(role.interview_type, { fallback: 'core' }),
  };
}

module.exports = {
  CANONICAL_INTERVIEW_TYPES,
  INTERVIEW_TYPE_ALIASES,
  INTERVIEW_TYPE_CONFIG,
  getInterviewTypeConfig,
  normalizeInterviewType,
  normalizeRoleInterviewTypeForRead,
  requireInterviewType,
};

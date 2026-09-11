'use strict';

const MAX_UNANSWERED_QUESTIONS = 10;
const CANDIDATE_ROLES = new Set(['candidate', 'user']);
const REPLICA_ROLES = new Set(['agent', 'assistant', 'interviewer', 'replica']);
const NON_FINAL_REPLICA_STATES = new Set([
  'in_progress',
  'incomplete',
  'interrupted',
  'partial',
  'streaming',
]);

const MARKER_RE_SOURCE = '\\[\\[UNANSWERED_QUESTION:\\s*([^\\]]+?)\\s*\\]\\]';
const INTERROGATIVE_RE =
  /^(who|what|when|where|why|how|can|could|would|do|does|is|are|should)\b/i;
const CLOSING_QUESTION_RE =
  /\b(do you have|any|any other)\b.{0,40}\bquestions?\b|\bquestions?\b.{0,40}\bbefore we wrap up\b/i;

function markerRegex(flags = 'g') {
  return new RegExp(MARKER_RE_SOURCE, flags);
}

function extractMarkers(text) {
  const markers = [];
  const regex = markerRegex();
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const question = String(match[1] || '').trim();
    if (question) markers.push(question);
  }
  return markers;
}

function stripMarkers(text) {
  return String(text || '').replace(markerRegex(), '').trim();
}

function candidateQuestionText(text) {
  const cleanedText = String(text || '').trim();
  if (!cleanedText) return '';
  const words = cleanedText.split(/\s+/).filter(Boolean);
  const sentenceMarks = cleanedText.match(/[.!?]+(?=\s|$)/g) || [];
  if (words.length > 35 || sentenceMarks.length > 2) return '';
  const lead = cleanedText
    .replace(/^(?:um+|uh+|so|and|also|just|yeah|yes|no|ok(?:ay)?|hey|hi)[,\s]+/i, '')
    .trim();
  return cleanedText.includes('?') || INTERROGATIVE_RE.test(lead)
    ? cleanedText
    : '';
}

function normalizeRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (CANDIDATE_ROLES.has(role)) return 'candidate';
  if (REPLICA_ROLES.has(role)) return 'replica';
  return 'other';
}

function textContent(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  for (const field of ['content', 'text', 'message', 'value']) {
    if (typeof item[field] === 'string') return item[field];
  }
  return '';
}

function normalizeArrayTurns(items) {
  return items.map((item) => ({
    role: normalizeRole(item?.role),
    text: textContent(item),
    source: item && typeof item === 'object' && !Array.isArray(item)
      ? item
      : null,
  }));
}

function normalizeTextTurns(transcriptText) {
  return String(transcriptText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const upper = line.toUpperCase();
      if (upper.startsWith('CANDIDATE:')) {
        return {
          role: 'candidate',
          text: line.slice('CANDIDATE:'.length).trim(),
          source: null,
        };
      }
      if (upper.startsWith('INTERVIEWER:')) {
        return {
          role: 'replica',
          text: line.slice('INTERVIEWER:'.length).trim(),
          source: null,
        };
      }
      return { role: 'other', text: line, source: null };
    });
}

function hasExplicitNonFinalState(source) {
  if (!source) return false;
  for (const field of ['is_final', 'isFinal', 'final', 'completed', 'is_complete']) {
    if (source[field] === false) return true;
  }
  const state = typeof source.status === 'string'
    ? source.status.trim().toLowerCase()
    : '';
  return NON_FINAL_REPLICA_STATES.has(state);
}

function isQualifyingReplicaResponse(turn, visibleText) {
  return turn.role === 'replica' &&
    visibleText.length > 0 &&
    !hasExplicitNonFinalState(turn.source);
}

function extractCandidateQuestions(input) {
  if (typeof input !== 'string' && !Array.isArray(input)) return [];

  const turns = Array.isArray(input)
    ? normalizeArrayTurns(input)
    : normalizeTextTurns(input);
  const candidates = [];
  let closingQuestionAsked = false;

  const addCandidate = (text) => {
    const question = String(text || '').trim();
    if (!question || candidates.some((candidate) => candidate.text === question)) return;
    candidates.push({ text: question, answered: false });
  };

  for (const turn of turns) {
    const markers = extractMarkers(turn.text);
    const visibleText = stripMarkers(turn.text);

    if (turn.role === 'replica') {
      if (isQualifyingReplicaResponse(turn, visibleText)) {
        for (const candidate of candidates) candidate.answered = true;
      }
      if (CLOSING_QUESTION_RE.test(visibleText)) closingQuestionAsked = true;
      if (!visibleText && markers.length) {
        for (const marker of markers) addCandidate(marker);
      }
      continue;
    }

    if (turn.role === 'candidate') {
      for (const marker of markers) addCandidate(marker);
      const question = candidateQuestionText(visibleText);
      if (closingQuestionAsked && question) addCandidate(question);
      continue;
    }

    // A marker without usable role evidence is retained rather than falsely
    // treating unknown metadata as a replica answer.
    for (const marker of markers) addCandidate(marker);
  }

  return candidates
    .filter((candidate) => !candidate.answered)
    .map((candidate) => candidate.text)
    .slice(0, MAX_UNANSWERED_QUESTIONS);
}

module.exports = {
  extractCandidateQuestions,
};

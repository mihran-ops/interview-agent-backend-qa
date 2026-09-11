'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');

const RESUME_INTEGRITY_VERSION = 'resume_integrity_r1_v1';
const RESUME_INTEGRITY_MODE = 'shadow_with_automation_gate';
const MAX_REASON_CODES = 8;
const MAX_DOCX_ZIP_ENTRIES = 512;
const MAX_DOCX_XML_ENTRIES = 64;
const MAX_DOCX_XML_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_DOCX_XML_TOTAL_BYTES = 16 * 1024 * 1024;

const SIGNAL_PATTERNS = Object.freeze({
  instruction_override: [
    /\b(?:ignore|disregard|forget|override|bypass)\b.{0,100}\b(?:previous|prior|above|earlier|system|developer|assistant|instructions?|prompt|rubric|criteria)\b/gi,
    /\bdo\s+not\s+(?:follow|obey|use)\b.{0,80}\b(?:instructions?|prompt|rubric|criteria)\b/gi
  ],
  score_manipulation: [
    /\b(?:give|assign|award|set|rate|score)\s+(?:this|the|my)\s+(?:resume|candidate|applicant|application|me)\b.{0,60}\b(?:100(?:\s*\/\s*100|\s*%)?|maximum|highest|perfect|top)\b/gi,
    /\b(?:resume_score|overall_score|overall_resume_match_percent|skills_match_percent)\s*[:=]\s*(?:100|99)\b/gi,
    /\b(?:return|output|respond\s+with)\b.{0,80}\b(?:a\s+)?(?:perfect|maximum|highest|100(?:\s*\/\s*100|\s*%)?)\s+(?:score|rating|match)\b/gi
  ],
  decision_manipulation: [
    /\b(?:rank|place)\s+(?:this|the|my)\s+(?:candidate|applicant|resume)\b.{0,50}\b(?:first|highest|top)\b/gi,
    /\b(?:select|advance|hire|recommend|shortlist)\s+(?:this|the|my)\s+(?:candidate|applicant)\b/gi
  ],
  model_impersonation: [
    /\b(?:you\s+are|act\s+as|behave\s+as)\b.{0,80}\b(?:chatgpt|language\s+model|ai\s+assistant|system\s+assistant|resume\s+(?:reviewer|screening\s+model)|hiring\s+model)\b/gi
  ],
  output_control: [
    /\b(?:output|return|respond\s+with)\b.{0,100}\b(?:strict\s+json|json\s+only|only\s+the\s+score|no\s+explanation|required\s+keys?)\b/gi
  ],
  prompt_boundary: [
    /(?:^|\n)\s*(?:\[\s*(?:system|developer|assistant)\s*\]|<\/?(?:system|developer|assistant)>|(?:system|developer|assistant)\s*:)/gi
  ]
});

function boundedCountMatches(text, patterns) {
  let total = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = String(text || '').match(pattern);
    total += Array.isArray(matches) ? matches.length : 0;
    if (total >= 20) return 20;
  }
  return total;
}

function meaningfulLength(value) {
  return String(value || '').replace(/\s+/g, '').length;
}

function inspectInstructionLikeContent(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .slice(0, 100000);
  const counts = Object.fromEntries(
    Object.entries(SIGNAL_PATTERNS).map(([name, patterns]) => [name, boundedCountMatches(text, patterns)])
  );

  const reasonCodes = [];
  if (counts.instruction_override > 0) reasonCodes.push('instruction_override_language');
  if (counts.score_manipulation > 0) reasonCodes.push('score_manipulation_language');
  if (counts.decision_manipulation > 0) reasonCodes.push('decision_manipulation_language');
  if (counts.model_impersonation > 0) reasonCodes.push('model_impersonation_language');
  if (counts.output_control > 0) reasonCodes.push('model_output_control_language');
  if (counts.prompt_boundary > 0) reasonCodes.push('prompt_boundary_language');

  const suspicious =
    counts.instruction_override > 0 ||
    counts.score_manipulation > 0 ||
    counts.decision_manipulation > 0 ||
    (counts.prompt_boundary > 0 && (counts.output_control > 0 || counts.model_impersonation > 0));

  return {
    status: meaningfulLength(text) > 0 ? (suspicious ? 'suspicious' : 'clean') : 'unassessed',
    reason_codes: reasonCodes.slice(0, MAX_REASON_CODES),
    signal_counts: counts
  };
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function extractRunText(runXml) {
  const values = [];
  const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
  let match;
  while ((match = pattern.exec(String(runXml || ''))) !== null) {
    values.push(decodeXmlText(match[1]));
  }
  return values.join('');
}

function enabledWordProperty(runXml, propertyName) {
  const pattern = new RegExp(`<w:${propertyName}\\b([^>]*)\\/?>(?:<\\/w:${propertyName}>)?`, 'i');
  const match = String(runXml || '').match(pattern);
  if (!match) return false;
  return !/\bw:val\s*=\s*["'](?:0|false|off)["']/i.test(match[1] || '');
}

function wordHalfPointSize(runXml) {
  const match = String(runXml || '').match(/<w:sz\b[^>]*\bw:val\s*=\s*["'](\d+)["'][^>]*\/?>/i);
  return match ? Number(match[1]) : null;
}

function hasWhiteTextColor(runXml) {
  const match = String(runXml || '').match(/<w:color\b[^>]*\bw:val\s*=\s*["']([0-9a-f]{6}|auto)["'][^>]*\/?>/i);
  return !!match && String(match[1]).toUpperCase() === 'FFFFFF';
}

function inspectDocxXml(xmlDocuments) {
  const formatCounts = {
    hidden_run_count: 0,
    hidden_text_chars: 0,
    tiny_run_count: 0,
    tiny_text_chars: 0,
    white_run_count: 0,
    white_text_chars: 0
  };
  let hiddenText = '';
  let tinyText = '';
  let whiteText = '';

  for (const xml of xmlDocuments) {
    const runs = String(xml || '').match(/<w:r\b[\s\S]*?<\/w:r>/gi) || [];
    for (const run of runs) {
      const text = extractRunText(run);
      const chars = meaningfulLength(text);
      if (!chars) continue;

      if (enabledWordProperty(run, 'vanish') || enabledWordProperty(run, 'webHidden')) {
        formatCounts.hidden_run_count += 1;
        formatCounts.hidden_text_chars += chars;
        hiddenText += `\n${text}`;
      }

      const size = wordHalfPointSize(run);
      if (Number.isFinite(size) && size <= 4) {
        formatCounts.tiny_run_count += 1;
        formatCounts.tiny_text_chars += chars;
        tinyText += `\n${text}`;
      }

      if (hasWhiteTextColor(run)) {
        formatCounts.white_run_count += 1;
        formatCounts.white_text_chars += chars;
        whiteText += `\n${text}`;
      }
    }
  }

  const hiddenSignals = inspectInstructionLikeContent(hiddenText);
  const tinySignals = inspectInstructionLikeContent(tinyText);
  const whiteSignals = inspectInstructionLikeContent(whiteText);
  const reasonCodes = [];

  if (formatCounts.hidden_text_chars >= 20 || hiddenSignals.status === 'suspicious') {
    reasonCodes.push('docx_hidden_text');
  }
  if (formatCounts.tiny_text_chars >= 40 || tinySignals.status === 'suspicious') {
    reasonCodes.push('docx_tiny_text');
  }
  if (whiteSignals.status === 'suspicious') {
    reasonCodes.push('docx_white_instruction_like_text');
  }

  return {
    suspicious: reasonCodes.length > 0,
    reason_codes: reasonCodes.slice(0, MAX_REASON_CODES),
    signal_counts: formatCounts
  };
}

async function inspectDocxFormatting(fileBuffer) {
  const zip = await JSZip.loadAsync(fileBuffer);
  const allNames = Object.keys(zip.files);
  if (allNames.length > MAX_DOCX_ZIP_ENTRIES) {
    throw new Error('docx_entry_limit_exceeded');
  }

  const names = allNames.filter((name) =>
    /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name)
  );
  if (names.length > MAX_DOCX_XML_ENTRIES) {
    throw new Error('docx_xml_entry_limit_exceeded');
  }

  let totalDeclaredBytes = 0;
  for (const name of names) {
    const declaredBytes = Number(zip.files[name]?._data?.uncompressedSize);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_DOCX_XML_ENTRY_BYTES) {
      throw new Error('docx_xml_size_limit_exceeded');
    }
    totalDeclaredBytes += declaredBytes;
    if (totalDeclaredBytes > MAX_DOCX_XML_TOTAL_BYTES) {
      throw new Error('docx_xml_total_size_limit_exceeded');
    }
  }

  const xmlDocuments = [];
  let totalInflatedBytes = 0;
  for (const name of names) {
    const inflated = await zip.file(name).async('nodebuffer');
    if (inflated.length > MAX_DOCX_XML_ENTRY_BYTES) {
      throw new Error('docx_xml_inflated_size_limit_exceeded');
    }
    totalInflatedBytes += inflated.length;
    if (totalInflatedBytes > MAX_DOCX_XML_TOTAL_BYTES) {
      throw new Error('docx_xml_inflated_total_limit_exceeded');
    }
    xmlDocuments.push(inflated.toString('utf8'));
  }
  return inspectDocxXml(xmlDocuments);
}

function inspectPdfFormatting(fileBuffer) {
  const raw = Buffer.isBuffer(fileBuffer)
    ? fileBuffer.toString('latin1')
    : Buffer.from(fileBuffer || '').toString('latin1');
  const invisibleModes = (raw.match(/(?:^|\s)3\s+Tr\b/g) || []).length;
  return {
    suspicious: false,
    reason_codes: [],
    signal_counts: {
      pdf_invisible_text_mode_markers: Math.min(invisibleModes, 20)
    }
  };
}

function mergeSignalCounts(...groups) {
  return groups.reduce((result, group) => {
    for (const [key, value] of Object.entries(group || {})) {
      result[key] = Number.isFinite(Number(value)) ? Math.min(9999, Number(value)) : 0;
    }
    return result;
  }, {});
}

async function assessResumeIntegrity({ text, fileBuffer, mimeType, roleText = '' } = {}) {
  const resumeSignals = inspectInstructionLikeContent(text);
  const roleSignals = inspectInstructionLikeContent(roleText);
  const normalizedMime = String(mimeType || '').toLowerCase();
  let formatAssessment = 'text_only';
  let formatSignals = { suspicious: false, reason_codes: [], signal_counts: {} };

  try {
    if (/wordprocessingml|officedocument|docx/.test(normalizedMime)) {
      formatSignals = await inspectDocxFormatting(fileBuffer);
      formatAssessment = 'structured_docx';
    } else if (/pdf/.test(normalizedMime)) {
      formatSignals = inspectPdfFormatting(fileBuffer);
      // R1 deliberately treats PDF rendering markers as telemetry only. Extracted
      // text still receives the complete instruction-language assessment above;
      // visual/layer comparison is deferred to a later phase to avoid penalizing
      // ordinary OCR and accessibility PDFs.
      formatAssessment = 'partial_pdf_text_only_non_gating';
    } else if (!normalizedMime) {
      formatAssessment = 'text_only';
    } else {
      formatAssessment = 'unsupported_format';
    }
  } catch {
    formatAssessment = 'format_inspection_failed';
  }

  const reasonCodes = [];
  reasonCodes.push(...resumeSignals.reason_codes.map((code) => `resume_${code}`));
  reasonCodes.push(...formatSignals.reason_codes);
  if (roleSignals.status === 'suspicious') {
    reasonCodes.push('role_requirements_instruction_like_content');
  }
  if (formatAssessment === 'format_inspection_failed') {
    reasonCodes.push('format_inspection_failed');
  }

  let status = 'clean';
  if (resumeSignals.status === 'unassessed') {
    status = 'unassessed';
    reasonCodes.push('resume_text_unassessed');
  } else if (resumeSignals.status === 'suspicious' || formatSignals.suspicious) {
    status = 'suspicious';
  } else if (roleSignals.status === 'suspicious' || formatAssessment === 'format_inspection_failed') {
    status = 'unassessed';
  }

  return {
    version: RESUME_INTEGRITY_VERSION,
    mode: RESUME_INTEGRITY_MODE,
    status,
    manual_review_required: status !== 'clean',
    automation_eligible: status === 'clean',
    format_assessment: formatAssessment,
    content_sha256: crypto.createHash('sha256').update(String(text || '')).digest('hex'),
    reason_codes: [...new Set(reasonCodes)].slice(0, MAX_REASON_CODES),
    signal_counts: mergeSignalCounts(
      Object.fromEntries(Object.entries(resumeSignals.signal_counts).map(([key, value]) => [`resume_${key}`, value])),
      Object.fromEntries(Object.entries(roleSignals.signal_counts).map(([key, value]) => [`role_${key}`, value])),
      formatSignals.signal_counts
    )
  };
}

function unassessedResumeIntegrity(reasonCode = 'legacy_or_missing_integrity_evidence') {
  return {
    version: RESUME_INTEGRITY_VERSION,
    mode: RESUME_INTEGRITY_MODE,
    status: 'unassessed',
    manual_review_required: true,
    automation_eligible: false,
    format_assessment: 'unknown',
    content_sha256: null,
    reason_codes: [String(reasonCode || 'legacy_or_missing_integrity_evidence').slice(0, 80)],
    signal_counts: {}
  };
}

function normalizeStoredResumeIntegrity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unassessedResumeIntegrity();
  }
  const status = ['clean', 'suspicious', 'unassessed'].includes(value.status)
    ? value.status
    : 'unassessed';
  const automationEligible = status === 'clean' && value.automation_eligible === true;
  return {
    version: String(value.version || 'unknown').slice(0, 80),
    mode: String(value.mode || 'unknown').slice(0, 80),
    status,
    manual_review_required: !automationEligible,
    automation_eligible: automationEligible,
    format_assessment: String(value.format_assessment || 'unknown').slice(0, 80),
    content_sha256: /^[a-f0-9]{64}$/i.test(String(value.content_sha256 || ''))
      ? String(value.content_sha256).toLowerCase()
      : null,
    reason_codes: Array.isArray(value.reason_codes)
      ? value.reason_codes.map((code) => String(code).slice(0, 80)).slice(0, MAX_REASON_CODES)
      : [],
    signal_counts: value.signal_counts && typeof value.signal_counts === 'object' && !Array.isArray(value.signal_counts)
      ? Object.fromEntries(Object.entries(value.signal_counts).slice(0, 30).map(([key, count]) => [
        String(key).slice(0, 80),
        Number.isFinite(Number(count)) ? Math.max(0, Math.min(9999, Number(count))) : 0
      ]))
      : {}
  };
}

module.exports = {
  RESUME_INTEGRITY_MODE,
  RESUME_INTEGRITY_VERSION,
  assessResumeIntegrity,
  inspectDocxXml,
  inspectInstructionLikeContent,
  normalizeStoredResumeIntegrity,
  unassessedResumeIntegrity
};

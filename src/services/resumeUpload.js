'use strict';

const crypto = require('crypto');
const path = require('path');
const mammoth = require('mammoth');
const { PDFParse, PasswordException } = require('pdf-parse');

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MIN_MEANINGFUL_TEXT_CHARS = 20;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const DOC_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

class ResumeUploadError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'ResumeUploadError';
    this.code = code;
    this.detail = detail;
  }
}

function meaningfulTextLength(value = '') {
  return String(value || '').replace(/\s+/g, '').length;
}

function normalizedExtension(file = {}) {
  return path.extname(String(file.originalname || '')).toLowerCase();
}

function assertResumeSize(file) {
  const size = Number(file?.size ?? file?.buffer?.length ?? 0);
  if (!file?.buffer || size <= 0) {
    throw new ResumeUploadError('RESUME_EMPTY', 'The resume file is empty.');
  }
  if (size > MAX_RESUME_BYTES) {
    throw new ResumeUploadError('RESUME_UNREADABLE', 'The resume exceeds the 10 MB size limit.');
  }
  return size;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({
    data: buffer,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0
  });

  try {
    const result = await parser.getText({ pageJoiner: '' });
    return String(result?.text || '');
  } catch (error) {
    if (error instanceof PasswordException || error?.name === 'PasswordException') {
      throw new ResumeUploadError(
        'RESUME_UNREADABLE',
        'The PDF is encrypted or password-protected.'
      );
    }
    throw new ResumeUploadError('RESUME_UNREADABLE', 'The PDF could not be read.');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function inspectResumeFile(file) {
  const sizeBytes = assertResumeSize(file);
  const extension = normalizedExtension(file);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ResumeUploadError('RESUME_UNREADABLE', 'The resume must be a PDF, DOC, or DOCX file.');
  }

  const buffer = file.buffer;
  const mimeType = String(file.mimetype || 'application/octet-stream').toLowerCase();
  let parseStatus = 'parsed';
  let extractedTextLength = 0;
  let parseNote = null;

  if (extension === '.pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new ResumeUploadError('RESUME_UNREADABLE', 'The selected file is not a valid PDF.');
    }
    const extractedText = await extractPdfText(buffer);
    extractedTextLength = meaningfulTextLength(extractedText);
    if (extractedTextLength < MIN_MEANINGFUL_TEXT_CHARS) {
      parseStatus = 'manual_review';
      parseNote = 'no_extractable_pdf_text';
    }
  } else if (extension === '.docx') {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || !buffer.includes(Buffer.from('word/document.xml'))) {
      throw new ResumeUploadError('RESUME_UNREADABLE', 'The selected file is not a valid DOCX document.');
    }
    try {
      const result = await mammoth.extractRawText({ buffer });
      extractedTextLength = meaningfulTextLength(result?.value || '');
    } catch {
      throw new ResumeUploadError('RESUME_UNREADABLE', 'The DOCX document could not be read.');
    }
    if (extractedTextLength < MIN_MEANINGFUL_TEXT_CHARS) {
      if (buffer.includes(Buffer.from('word/media/'))) {
        parseStatus = 'manual_review';
        parseNote = 'image_only_docx';
      } else {
        throw new ResumeUploadError('RESUME_EMPTY', 'The DOCX document does not contain readable resume content.');
      }
    }
  } else {
    if (!buffer.subarray(0, DOC_MAGIC.length).equals(DOC_MAGIC)) {
      throw new ResumeUploadError('RESUME_UNREADABLE', 'The selected file is not a valid DOC document.');
    }
    parseStatus = 'manual_review';
    parseNote = 'legacy_doc_requires_manual_review';
  }

  return {
    original_filename: String(file.originalname || '').slice(0, 255) || null,
    extension: extension.slice(1),
    mime_type: mimeType,
    size_bytes: sizeBytes,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    parse_status: parseStatus,
    parse_note: parseNote,
    extracted_text_length: extractedTextLength
  };
}

async function uploadResumeObject({ storage, bucket, objectPath, file, inspection }) {
  const result = await storage.from(bucket).upload(objectPath, file.buffer, {
    contentType: inspection.mime_type,
    upsert: true
  });
  if (result?.error) {
    throw new ResumeUploadError('RESUME_UPLOAD_FAILED', 'The resume storage write failed.');
  }
  return `${bucket}/${objectPath}`;
}

module.exports = {
  MAX_RESUME_BYTES,
  MIN_MEANINGFUL_TEXT_CHARS,
  ResumeUploadError,
  inspectResumeFile,
  uploadResumeObject
};

'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { supabaseAdmin } = require('../../clients/supabase');
const { parseBufferToText } = require('../../render/jdParser');
const { normalizeRoleInterviewTypeForRead } = require('../../services/interviewTypes');
const {
  ServiceRoleAuthorizationError,
  requireRoleAccess,
} = require('../../services/serviceRoleAuthorization');

// Canonical JD storage bucket; store job_description_url as "<bucket>/<path>".
const JD_BUCKET = (process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET || process.env.SUPABASE_JD_BUCKET || 'job-descriptions').trim();

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const okExt = ['.pdf', '.docx']; // parser supports pdf/docx
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!okExt.includes(ext)) return cb(new Error('Only PDF or DOCX allowed'));
    cb(null, true);
  },
});

function okContentType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

/**
 * POST /roles-upload/upload-jd?client_id=...&role_id=...
 * FormData: file
 *
 * NOTE: app.js wraps this router with requireAuth + withClientScope.
 * Side effects:
 *  - Uploads JD file to JD_BUCKET
 *  - Parses text (pdf/docx)
 *  - Updates role: job_description_url, job_description_text
 *  - (NEW) Conditionally enriches rubric/KB if role has neither rubric nor KB yet
 * Returns: { ok, role, parsed_text_preview }
 */
router.post('/upload-jd', upload.single('file'), async (req, res) => {
  try {
    const client_id = req.query.client_id || req.body.client_id || null;
    const role_id = req.query.role_id || req.body.role_id || null;
    if (!client_id) return res.status(400).json({ error: 'Missing client_id' });
    if (!role_id) return res.status(400).json({ error: 'Missing role_id' });

    const { role: authorizedRole } = await requireRoleAccess({
      db: supabaseAdmin,
      req,
      roleId: role_id,
      clientId: client_id,
      manage: true,
      columns: 'id,client_id',
    });

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname || '').toLowerCase();
    const contentType = okContentType(originalname);

    // 1) Upload JD file to storage (no bucket prefix in key)
    const objectKey = `${client_id}/${role_id}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const up = await supabaseAdmin.storage
      .from(JD_BUCKET)
      .upload(objectKey, buffer, { contentType, upsert: true });

    if (up.error) {
      console.error('[upload-jd] storage upload error:', up.error.message);
      return res.status(500).json({ error: 'JD upload failed', detail: up.error.message });
    }

    const job_description_url = `${JD_BUCKET}/${objectKey}`;

    // 2) Parse JD text to populate roles.job_description_text (best-effort)
    let parsedText = '';
    try {
      parsedText = await parseBufferToText(buffer, contentType, originalname);
    } catch (e) {
      console.error('[upload-jd] parse failed:', e?.message || e);
    }

    const updates = { job_description_url };
    if (parsedText) {
      const descriptionExcerpt = parsedText.replace(/\s+/g, ' ').trim().slice(0, 400);
      updates.job_description_text = parsedText;
      updates.description = descriptionExcerpt || null;
    }

    // 3) Update role with JD path (+ optional parsed JD text)
    let { data: updated, error: updErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', authorizedRole.id)
      .eq('client_id', authorizedRole.client_id)
      .select('id,title,client_id,slug_or_token,interview_type,job_description_url,job_description_text,description,rubric,kb_document_id,tavus_document_id,created_at')
      .single();

    if (updErr) {
      console.error('[upload-jd] role update error:', updErr.message);
      return res.status(500).json({ error: 'Role update failed', detail: updErr.message });
    }

    // 4) (NEW) Conditional enrichment:
    // Only run if the role has neither a rubric nor a KB doc yet.
    // This avoids overwriting any existing curated content.
    const needsEnrichment = !updated?.rubric && !updated?.kb_document_id;
    if (needsEnrichment) {
      try {
        const { generateRubricAndKBForRole } = require('../../services/generateRubric');
        await generateRubricAndKBForRole(role_id);

        // Re-fetch the role so FE gets fresh rubric/kb fields in the response
        const refetch = await supabaseAdmin
          .from('roles')
          .select('id,title,client_id,slug_or_token,interview_type,job_description_url,job_description_text,description,rubric,kb_document_id,tavus_document_id,created_at')
          .eq('id', role_id)
          .single();
        if (!refetch.error && refetch.data) {
          updated = refetch.data;
        }
      } catch (e) {
        console.error('[upload-jd] post-upload enrichment failed:', e?.message || e);
        // Do not fail the upload response—JD is saved and parsed text set.
      }
    }

    // 5) Respond with role + preview
    return res.json({
      ok: true,
      role: normalizeRoleInterviewTypeForRead(updated),
      parsed_text_preview: (parsedText || '').slice(0, 1200)
    });
  } catch (e) {
    if (e instanceof ServiceRoleAuthorizationError) {
      return res.status(e.status).json({ error: e.status === 404 ? 'Not found' : 'Forbidden' });
    }
    console.error('[upload-jd] unexpected:', e?.message || e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

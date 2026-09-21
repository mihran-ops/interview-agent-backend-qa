'use strict';

const express = require('express');
const multer = require('multer');
const {
  MAX_DOCUMENT_BYTES,
  buildAdminSalesPayrollPayload,
  createAdjustmentDocumentUrl,
  createSalesPayrollAdjustment,
  safePayrollErrorBody,
} = require('../../services/adminSalesPayrollService');

function createAdminSalesPayrollRouter({ db } = {}) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  });

  function respondError(res, req, error) {
    return res.status(Number(error?.status) || 500).json(safePayrollErrorBody(error, req.request_id || null));
  }

  router.get('/', async (req, res) => {
    try {
      const payload = await buildAdminSalesPayrollPayload({
        db,
        query: req.query || {},
        requestId: req.request_id || null,
      });
      return res.json(payload);
    } catch (error) {
      return respondError(res, req, error);
    }
  });

  router.post('/adjustments', (req, res) => {
    upload.single('documentation')(req, res, async (uploadError) => {
      if (uploadError) {
        const error = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE'
          ? Object.assign(new Error('Supporting document must be 10 MB or smaller.'), { status: 400, code: 'document_too_large' })
          : Object.assign(new Error('Could not read the supporting document.'), { status: 400, code: 'document_upload_invalid' });
        return respondError(res, req, error);
      }
      try {
        const adjustment = await createSalesPayrollAdjustment({
          db,
          body: req.body || {},
          file: req.file || null,
          actor: req.user || {},
        });
        return res.status(201).json({ ok: true, adjustment });
      } catch (error) {
        return respondError(res, req, error);
      }
    });
  });

  router.get('/adjustments/:id/document', async (req, res) => {
    try {
      const document = await createAdjustmentDocumentUrl({ db, adjustmentId: req.params.id });
      return res.json({ ok: true, document });
    } catch (error) {
      return respondError(res, req, error);
    }
  });

  return router;
}

module.exports = { createAdminSalesPayrollRouter };

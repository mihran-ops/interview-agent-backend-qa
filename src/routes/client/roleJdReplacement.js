'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');

const {
  JD_FILE_TYPES,
  JD_MAX_BYTES,
  RoleJdReplacementError,
  createRoleJdReplacementService
} = require('../../services/roleJdReplacement');

function normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'superadmin' ? 'super_admin' : normalized;
}

function hasReplacementWriteAccess(req, clientId) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true;
  const targetClientId = String(clientId || '').trim();
  const memberships = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships
    : [];
  const membership = memberships.find((item) => String(item?.client_id || '').trim() === targetClientId);
  return ['manager', 'admin', 'owner', 'super_admin'].includes(normalizeRole(membership?.role));
}

function createUploadMiddleware() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: JD_MAX_BYTES },
    fileFilter: (_req, file, callback) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!JD_FILE_TYPES[ext]) {
        const error = new Error('Only PDF or DOCX job descriptions are supported.');
        error.code = 'UNSUPPORTED_JD_FILE';
        return callback(error);
      }
      return callback(null, true);
    }
  });

  return (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'Job description file exceeds the 20MB limit.',
          code: 'JD_FILE_TOO_LARGE'
        });
      }
      if (error.code === 'UNSUPPORTED_JD_FILE') {
        return res.status(415).json({ error: error.message, code: error.code });
      }
      return res.status(400).json({ error: 'Invalid job description upload.', code: 'INVALID_JD_UPLOAD' });
    });
  };
}

function createRoleJdReplacementRouter(options = {}) {
  const router = express.Router();
  const authMiddleware = options.requireAuth || require('../../middleware/auth').requireAuth;
  const scopeMiddleware = options.withClientScope || require('../../middleware/auth').withClientScope;
  let service = options.service || null;
  const uploadMiddleware = options.uploadMiddleware || createUploadMiddleware();

  router.post(
    '/:id/job-description-replacement',
    authMiddleware,
    uploadMiddleware,
    scopeMiddleware,
    async (req, res) => {
      const clientId = String(req.body?.client_id || req.query?.client_id || '').trim();
      if (!clientId) {
        return res.status(400).json({ error: 'client_id is required.', code: 'CLIENT_ID_REQUIRED' });
      }
      if (!hasReplacementWriteAccess(req, clientId)) {
        return res.status(403).json({ error: 'Forbidden', code: 'ROLE_REPLACEMENT_FORBIDDEN' });
      }

      try {
        if (!service) service = createRoleJdReplacementService();
        const result = await service.replaceJobDescription({
          roleId: req.params.id,
          clientId,
          file: req.file,
          reason: req.body?.reason || null,
          actorUserId: req.user?.id || null,
          actorType: req.isGlobalAdmin === true || req.isAdmin === true
            ? 'global_admin'
            : 'client_member'
        });
        return res.json(result);
      } catch (error) {
        const status = error instanceof RoleJdReplacementError
          ? error.status
          : Number(error?.status) || 500;
        if (status >= 500) {
          console.error('[POST /roles/:id/job-description-replacement]', error?.message || error);
        }
        return res.status(status).json({
          error: error?.message || 'Job description replacement failed.',
          code: error?.code || 'ROLE_JD_REPLACEMENT_FAILED',
          detail: error?.detail || null
        });
      }
    }
  );

  return router;
}

module.exports = {
  createRoleJdReplacementRouter,
  createUploadMiddleware,
  hasReplacementWriteAccess
};

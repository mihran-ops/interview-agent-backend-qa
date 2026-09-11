// routes/authPing.js
const express = require('express');
const router = express.Router();

const { requireAuth, withClientScope } = require('../../middleware/auth');

// Existing ping
router.get('/ping', requireAuth, withClientScope, (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    user: req.user || null,
    client: req.client || (req.clientScope?.defaultClientId
      ? { id: req.clientScope.defaultClientId }
      : null),
    scope: req.clientScope || null,
  });
});

// New: many FE helpers expect /auth/me
router.get('/me', requireAuth, withClientScope, (req, res) => {
  res.json({
    ok: true,
    user: req.user || null,
    client: req.client || (req.clientScope?.defaultClientId
      ? { id: req.clientScope.defaultClientId }
      : null),
    scope: req.clientScope || null,
  });
});

module.exports = router;

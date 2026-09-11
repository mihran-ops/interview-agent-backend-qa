'use strict';

// Dashboard row shims kept at their legacy paths.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const path = require('path');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const { buildDashboardRows } = require('../../services/dashboard/dashboardRows');

const router = express.Router();

// Existing path (kept for compatibility)
router.get('/dashboard/interviews', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// New path used by the FE
router.get('/dashboard/rows', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})


module.exports = router;

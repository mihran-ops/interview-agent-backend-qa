'use strict';

// The automation router. The three groups keep the order they had in
// routes/automation.js, which is what decides whether /actions/:id/... or a
// literal /actions/... path answers a request.

const express = require('express');

const router = express.Router();

router.use(require('./rules'));
router.use(require('./digests'));
router.use(require('./approvals'));

module.exports = router;

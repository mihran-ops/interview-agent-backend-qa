'use strict';

// The /internal surface: scheduler-triggered endpoints, each authenticated by its own
// cron secret. Mounted at /internal, which is where these routes lived in app.js.

const express = require('express');

const router = express.Router();

router.use(require('./contracts'));
router.use(require('./otpCleanup'));
router.use(require('./recordingCleanup'));
router.use(require('./usageBilling'));

module.exports = router;

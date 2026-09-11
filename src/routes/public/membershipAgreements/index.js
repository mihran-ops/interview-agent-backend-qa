'use strict';

// The public membership agreement router, in the order the endpoints were
// registered in routes/membershipAgreementsPublic.js.

const express = require('express');

const router = express.Router();

router.use(require('./signing'));
router.use(require('./checkout'));
router.use(require('./documents'));

module.exports = router;

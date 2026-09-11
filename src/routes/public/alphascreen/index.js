'use strict';

// The self-serve purchase router. The three flows keep the order they had in
// routes/alphaScreenPackages.js.

const express = require('express');

const {
  normalizePurchaseIntentInput,
  validatePurchaseIntentInput,
  safePackageSummary,
  buildPurchaseIntentResponse,
  buildAgreementInputFromPurchaseIntent,
  validatePurchaseIntentForAgreement,
  validatePurchaseIntentForEmailVerification,
  generateRetailVerificationCode,
  hashRetailVerificationCode,
  hasValidRetailEmailVerification,
} = require('../../../services/alphaScreen');

const router = express.Router();

router.use(require('./purchaseIntents'));
router.use(require('./verification'));
router.use(require('./agreements'));

module.exports = router;
// Kept on the router so the existing tests reach these helpers through the same
// handle they used when they lived in the route file.
router._test = {
  normalizePurchaseIntentInput,
  validatePurchaseIntentInput,
  safePackageSummary,
  buildPurchaseIntentResponse,
  buildAgreementInputFromPurchaseIntent,
  validatePurchaseIntentForAgreement,
  validatePurchaseIntentForEmailVerification,
  generateRetailVerificationCode,
  hashRetailVerificationCode,
  hasValidRetailEmailVerification,
};

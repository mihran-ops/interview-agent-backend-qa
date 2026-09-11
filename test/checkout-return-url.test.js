'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')

const urlConfigPath = path.join(__dirname, '..', 'src', 'config', 'urlConfig.js')

function loadUrlConfigWithEnv(overrides = {}) {
  const original = {}
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key]
    process.env[key] = overrides[key]
  }
  delete require.cache[urlConfigPath]
  const config = require(urlConfigPath)
  return {
    config,
    restore() {
      for (const key of Object.keys(overrides)) {
        if (original[key] === undefined) delete process.env[key]
        else process.env[key] = original[key]
      }
      delete require.cache[urlConfigPath]
    }
  }
}

test('public checkout success URL targets the buyer-facing return page without Stripe secrets', () => {
  const { config, restore } = loadUrlConfigWithEnv({
    PUBLIC_SITE_BASE: 'https://qa.alphasourceai.com'
  })

  try {
    const url = config.buildPublicCheckoutSuccessUrl({
      checkout: 'success',
      status: 'setup_pending',
      client_id: 'client_123'
    })

    assert.equal(
      url,
      'https://qa.alphasourceai.com/checkout/subscription-success?checkout=success&status=setup_pending&client_id=client_123'
    )
    assert.doesNotMatch(url, /session_id|cs_test|sk_test|sk_live/i)
  } finally {
    restore()
  }
})

'use strict'

const assert = require('node:assert/strict')
const express = require('express')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

const supabaseClientPath = path.join(__dirname, '..', 'src', 'clients', 'supabase.js')
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} }
}

const { createSalesRouter } = require('../src/routes/sales')

function matches(row, filters) {
  return filters.every(({ column, value }) => String(row?.[column] ?? '') === String(value ?? ''))
}

class Query {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.filters = []
    this.inFilter = null
  }
  select() { return this }
  eq(column, value) { this.filters.push({ column, value }); return this }
  in(column, values) { this.inFilter = { column, values: new Set(values.map(String)) }; return this }
  order() { return this }
  rows() {
    const rows = this.db[this.table] || []
    return rows.filter((row) => matches(row, this.filters) && (!this.inFilter || this.inFilter.values.has(String(row[this.inFilter.column]))))
  }
  async maybeSingle() { return { data: this.rows()[0] || null, error: null } }
  then(resolve, reject) { return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject) }
}

function makeDb() {
  return {
    public_purchase_intents: [{
      id: 'deal-owned',
      channel: 'sales_assisted',
      created_by_user_id: 'rep-1',
      status: 'agreement_pending',
      selected_plan_key: 'basic',
      selected_billing_cadence: 'monthly',
      package_snapshot: { display_name: 'Essential', platform_fee_cents: 29900 },
      company_legal_name: 'Owned Company LLC',
      company_dba: '',
      buyer_first_name: 'Alex',
      buyer_last_name: 'Rivera',
      buyer_email: 'alex@example.com',
      buyer_phone: '720-555-0100',
      buyer_title: 'Owner',
      agreement_id: 'agreement-owned',
      created_at: '2026-09-18T12:00:00.000Z',
      updated_at: '2026-09-18T12:00:00.000Z',
      initial_payment_cents: 29900
    }, {
      id: 'deal-other',
      channel: 'sales_assisted',
      created_by_user_id: 'rep-2',
      status: 'agreement_pending',
      selected_plan_key: 'pro',
      selected_billing_cadence: 'annual',
      agreement_id: 'agreement-other'
    }],
    membership_agreements: [{ id: 'agreement-owned', status: 'sent', is_current: true }],
    sales_deal_events: [{ id: 'event-1', purchase_intent_id: 'deal-owned', event_type: 'agreement_sent', safe_metadata: {}, created_at: '2026-09-18T12:01:00.000Z' }],
    from(table) { return new Query(this, table) }
  }
}

function appFor(repUserId) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.salesRep = { user_id: repUserId, email: `${repUserId}@example.com`, display_name: repUserId }
    next()
  })
  app.use('/sales', createSalesRouter({ db: makeDb() }))
  return app
}

async function getJson(app, pathname) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`)
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('deal detail returns the owner-safe summary and timeline', async () => {
  const response = await getJson(appFor('rep-1'), '/sales/deals/deal-owned')
  assert.equal(response.status, 200)
  assert.equal(response.body.id, 'deal-owned')
  assert.equal(response.body.company_legal_name, 'Owned Company LLC')
  assert.equal(response.body.timeline.length, 1)
  assert.equal(response.body.timeline[0].event_type, 'agreement_sent')
  assert.equal('signer_token_hash' in response.body, false)
})

test('deal detail returns 404 for another representative owner', async () => {
  const response = await getJson(appFor('rep-1'), '/sales/deals/deal-other')
  assert.equal(response.status, 404)
  assert.equal(response.body.code, 'deal_not_found')
})

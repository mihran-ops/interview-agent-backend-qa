'use strict';

// Cron entry point for annual Enterprise usage invoices. Guarded by a shared
// secret header rather than a user session, because the caller is the scheduler.
//
// Monthly Enterprise clients need nothing here: their usage is added to the
// platform-fee invoice each cycle by the invoice.created webhook. An annual
// client only gets that invoice once a year, so their usage is raised as its own
// invoice on the subscription anniversary day of each month.

const express = require('express');

const { supabaseAdmin } = require('../../clients/supabase');
const { createImmediateUsageInvoice, isAnniversaryToday } = require('../../services/usageBilling');
const { secretsMatch } = require('../../services/secretCompare');

const router = express.Router();

// PostgREST caps a response at 1,000 rows by default, so both lookups below page
// rather than silently billing only the first page once there are more usage
// clients than that. Each page is ordered, without which range paging can repeat
// or skip rows.
const PAGE_SIZE = 500;
// An `in` filter becomes a query string, so the id list is sent in chunks rather
// than as one very long URL.
const ID_CHUNK_SIZE = 200;
// A stop so a backend that never returns a short page cannot spin forever.
const MAX_PAGES = 200;

async function readAllPages(buildQuery) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { rows: null, error };
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, error: null };
  }
  console.warn('usage_billing_cron_page_limit_reached', { page_size: PAGE_SIZE, max_pages: MAX_PAGES });
  return { rows, error: null };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

router.post('/billing/usage-invoices', async (req, res) => {
  const expectedSecret = String(process.env.USAGE_BILLING_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!secretsMatch(providedSecret, expectedSecret)) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const requestId = req.request_id || null
  const now = new Date()

  try {
    const { rows: settings, error: settingsError } = await readAllPages(() => supabaseAdmin
      .from('client_plan_settings')
      .select('client_id')
      .eq('billing_model', 'usage')
      .order('client_id', { ascending: true }))
    if (settingsError) {
      return res.status(500).json({ error: 'usage_clients_lookup_failed', detail: settingsError.message })
    }

    const clientIds = [...new Set((settings || []).map((row) => String(row?.client_id || '')).filter(Boolean))]
    if (!clientIds.length) {
      console.log('usage_billing_cron_summary', { request_id: requestId, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0 })
      return res.json({ ok: true, considered: 0, invoiced: 0, skipped: 0, failed: 0, total_cents: 0, results: [] })
    }

    const clients = []
    for (const idChunk of chunk(clientIds, ID_CHUNK_SIZE)) {
      const { rows, error: clientsError } = await readAllPages(() => supabaseAdmin
        .from('clients')
        .select('id,name,billing_interval,stripe_customer_id,contract_start_at,current_term_end')
        .in('id', idChunk)
        .eq('billing_interval', 'annual')
        .order('id', { ascending: true }))
      if (clientsError) {
        return res.status(500).json({ error: 'usage_clients_lookup_failed', detail: clientsError.message })
      }
      clients.push(...rows)
    }

    const due = clients.filter((client) => isAnniversaryToday(client, now))

    // Required here rather than at the top of the file so that mounting this
    // router does not construct the Stripe client, the way the other routes that
    // reach Stripe do it.
    const stripe = require('../../clients/stripe')

    const results = []
    let invoiced = 0
    let skipped = 0
    let failed = 0
    let totalCents = 0

    for (const client of due) {
      // One client's failure must not stop the rest of the run.
      try {
        const result = await createImmediateUsageInvoice({
          db: supabaseAdmin,
          stripe,
          clientId: client.id,
          customerId: client.stripe_customer_id || null,
          periodEnd: now.toISOString(),
          requestId,
          reason: 'monthly_cycle',
          now: now.toISOString()
        })
        if (result.skipped) {
          skipped += 1
          results.push({ client_id: client.id, status: 'skipped', reason: result.reason || null })
          console.log('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'skipped', reason: result.reason || null })
        } else {
          invoiced += 1
          totalCents += Number(result.total_cents || 0)
          results.push({ client_id: client.id, status: 'invoiced', invoice_id: result.invoice_id, total_cents: result.total_cents })
          console.log('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'invoiced', invoice_id: result.invoice_id, total_cents: result.total_cents })
        }
      } catch (e) {
        failed += 1
        results.push({ client_id: client.id, status: 'failed', error: e?.message || 'usage_invoice_failed' })
        console.error('usage_billing_cron_client', { request_id: requestId, client_id: client.id, status: 'failed', error: e?.message || String(e) })
      }
    }

    console.log('usage_billing_cron_summary', {
      request_id: requestId,
      considered: due.length,
      invoiced,
      skipped,
      failed,
      total_cents: totalCents
    })

    return res.json({ ok: true, considered: due.length, invoiced, skipped, failed, total_cents: totalCents, results })
  } catch (e) {
    return res.status(500).json({ error: 'usage_invoices_failed', detail: e?.detail || e?.message || 'usage_invoices_failed' })
  }
})

module.exports = router;

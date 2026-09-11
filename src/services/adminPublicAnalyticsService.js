'use strict';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUMMARY_LIMIT = 500;
const CSV_EXPORT_LIMIT = 1000;
const BULK_ARCHIVE_LIMIT = 50;
const VALID_LEAD_STATUSES = new Set(['partial', 'abandoned', 'submitted']);
const VALID_ARCHIVE_STATUSES = new Set(['active', 'archived', 'all']);
const SAFE_EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_META_KEY_RE = /(authorization|bearer|cookie|token|secret|password|credential|email|phone|message|body|payload|form|name|ip|user[_-]?agent)/i;
const LEAD_SELECT_COLUMNS = 'id,status,form_id,form_type,product_interest,first_name,last_name,email,phone,message,fields_completed,last_field,source_path,source_referrer_path,source_cta,utm,privacy_notice_version,submitted_at,expires_at,archived_at,archived_by_user_id,archive_reason,created_at,updated_at';
const PAGE_DISPLAY_NAMES = {
  '/': 'Homepage',
  '/alphascreen': 'alphaScreen',
  '/alphascreen/pricing': 'alphaScreen Pricing',
  '/about': 'About',
  '/support': 'Support',
  '/faq': 'FAQ',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms & Conditions',
};

function trimText(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseDateBoundary(value, endOfDay = false) {
  const raw = trimText(value, 40);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoDateOnly(value) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function parseDateRange(query = {}, now = new Date()) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const days = parsePositiveInt(query.days || query.date_range, DEFAULT_DAYS, MAX_DAYS);
  const defaultFrom = new Date(safeNow.getTime() - days * 24 * 60 * 60 * 1000);
  const from = parseDateBoundary(query.date_from, false) || defaultFrom;
  const to = parseDateBoundary(query.date_to, true) || safeNow;
  return {
    days,
    from,
    to,
    date_range: trimText(query.date_from) || trimText(query.date_to) ? 'custom' : `${days}d`,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to),
  };
}

function cleanPath(value) {
  const raw = trimText(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com');
    return trimText(url.pathname || '/', 300);
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300);
  }
}

function pageDisplayName(path) {
  const clean = cleanPath(path) || '/';
  if (PAGE_DISPLAY_NAMES[clean]) return PAGE_DISPLAY_NAMES[clean];
  return clean;
}

function parseFilters(query = {}, now = new Date()) {
  const dateRange = parseDateRange(query, now);
  const leadStatus = trimText(query.status || query.lead_status, 40).toLowerCase();
  const archiveStatus = trimText(query.archive_status, 40).toLowerCase();
  const eventName = trimText(query.event_name || query.event, 100).toLowerCase();
  return {
    ...dateRange,
    lead_status: VALID_LEAD_STATUSES.has(leadStatus) ? leadStatus : '',
    archive_status: VALID_ARCHIVE_STATUSES.has(archiveStatus) ? archiveStatus : 'active',
    event_name: SAFE_EVENT_NAME_RE.test(eventName) ? eventName : '',
    path: cleanPath(query.path || query.page_path),
    lead_page: parsePositiveInt(query.lead_page || query.page, 1, 10000),
    event_page: parsePositiveInt(query.event_page || query.page, 1, 10000),
    lead_limit: parsePositiveInt(query.lead_limit || query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    event_limit: parsePositiveInt(query.event_limit || query.limit, DEFAULT_LIMIT, MAX_LIMIT),
  };
}

function applyDateRange(query, column, filters) {
  return query
    .gte(column, filters.date_from)
    .lte(column, filters.date_to);
}

function applyLeadFilters(query, filters) {
  let next = applyDateRange(query, 'updated_at', filters);
  if (filters.lead_status) next = next.eq('status', filters.lead_status);
  if (filters.path) next = next.eq('source_path', filters.path);
  if (filters.archive_status === 'active') next = next.is('archived_at', null);
  if (filters.archive_status === 'archived') next = next.not('archived_at', 'is', null);
  return next;
}

function applyEventFilters(query, filters) {
  let next = applyDateRange(query, 'occurred_at', filters);
  if (filters.event_name) next = next.eq('event_name', filters.event_name);
  if (filters.path) next = next.eq('path', filters.path);
  return next;
}

async function runQuery(builder, code) {
  const { data, error } = await builder;
  if (error) {
    const serviceError = new Error('Could not load public analytics records.');
    serviceError.code = code;
    serviceError.status = 503;
    throw serviceError;
  }
  return Array.isArray(data) ? data : [];
}

function pageRange(page, limit) {
  const offset = (page - 1) * limit;
  return { from: offset, to: offset + limit };
}

async function readLeadRows(db, filters, { page = 1, limit = DEFAULT_LIMIT, summary = false, exportRows = false } = {}) {
  let query = db
    .from('public_lead_drafts')
    .select(LEAD_SELECT_COLUMNS);
  query = applyLeadFilters(query, filters).order('updated_at', { ascending: false });
  if (summary) query = query.limit(SUMMARY_LIMIT);
  else if (exportRows) query = query.limit(CSV_EXPORT_LIMIT + 1);
  else {
    const range = pageRange(page, limit);
    query = query.range(range.from, range.to);
  }
  return runQuery(query, 'public_leads_read_failed');
}

async function readEventRows(db, filters, { page = 1, limit = DEFAULT_LIMIT, summary = false } = {}) {
  let query = db
    .from('public_analytics_events')
    .select('id,event_name,path,page_title,referrer_path,utm,properties,occurred_at,created_at');
  query = applyEventFilters(query, filters).order('occurred_at', { ascending: false });
  if (summary) query = query.limit(SUMMARY_LIMIT);
  else {
    const range = pageRange(page, limit);
    query = query.range(range.from, range.to);
  }
  return runQuery(query, 'public_events_read_failed');
}

function safeMetaValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    return trimText(value, 120)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9._-]+/gi, '[redacted]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted-phone]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]');
  }
  if (Array.isArray(value)) return `array(${Math.min(value.length, 20)})`;
  if (typeof value === 'object') return 'object';
  return '';
}

function eventDisplayName(eventName) {
  const raw = trimText(eventName, 100) || 'unknown';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function safeSummaryText(value, fallback = 'Unknown') {
  const safe = safeMetaValue(value);
  return trimText(safe, 120) || fallback;
}

function incrementCount(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function latestIso(...values) {
  let latest = '';
  for (const value of values) {
    const raw = trimText(value, 40);
    if (raw && (!latest || raw > latest)) latest = raw;
  }
  return latest;
}

function summarizeObject(value, maxItems = 4) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { keys: [], entries: [] };
  }
  const keys = [];
  const entries = [];
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = trimText(key, 80);
    if (!safeKey || SENSITIVE_META_KEY_RE.test(safeKey)) continue;
    keys.push(safeKey);
    if (entries.length < maxItems) {
      const safeValue = safeMetaValue(raw);
      if (safeValue) entries.push({ key: safeKey, value: safeValue });
    }
  }
  return {
    keys: keys.slice(0, 12),
    entries,
  };
}

function messagePreview(row) {
  if (row?.status !== 'submitted') return null;
  const text = safeMetaValue(row?.message);
  return text || null;
}

function sanitizeLead(row) {
  const firstName = trimText(row?.first_name, 80);
  const lastName = trimText(row?.last_name, 80);
  const fieldsCompleted = Array.isArray(row?.fields_completed) ? row.fields_completed.filter(Boolean) : [];
  const utm = summarizeObject(row?.utm || {}, 5);
  const preview = messagePreview(row);
  return {
    id: trimText(row?.id, 80),
    status: trimText(row?.status, 40) || 'unknown',
    form_id: trimText(row?.form_id, 120) || null,
    form_type: trimText(row?.form_type, 80) || null,
    product_interest: trimText(row?.product_interest, 120) || null,
    contact: {
      first_name: firstName || null,
      last_name: lastName || null,
      full_name: [firstName, lastName].filter(Boolean).join(' ') || null,
      email: trimText(row?.email, 254) || null,
      phone: trimText(row?.phone, 40) || null,
    },
    source: {
      path: cleanPath(row?.source_path) || '/',
      referrer_path: cleanPath(row?.source_referrer_path) || null,
      cta: trimText(row?.source_cta, 160) || null,
      utm_summary: utm.entries,
      utm_keys: utm.keys,
    },
    progress: {
      fields_completed_count: fieldsCompleted.length,
      fields_completed: fieldsCompleted.slice(0, 12).map((field) => trimText(field, 80)).filter(Boolean),
      last_field: trimText(row?.last_field, 80) || null,
    },
    message_preview: preview,
    message_character_count: trimText(row?.message, 5000).length || 0,
    privacy_notice_version: trimText(row?.privacy_notice_version, 120) || null,
    archived: Boolean(trimText(row?.archived_at, 40)),
    archived_at: trimText(row?.archived_at, 40) || null,
    archive_reason: trimText(row?.archive_reason, 200) || null,
    submitted_at: trimText(row?.submitted_at, 40) || null,
    expires_at: trimText(row?.expires_at, 40) || null,
    created_at: trimText(row?.created_at, 40) || null,
    updated_at: trimText(row?.updated_at, 40) || null,
  };
}

function sanitizeEvent(row) {
  const utm = summarizeObject(row?.utm || {}, 4);
  const properties = summarizeObject(row?.properties || {}, 5);
  return {
    id: trimText(row?.id, 80),
    event_name: trimText(row?.event_name, 100) || 'unknown',
    path: cleanPath(row?.path) || '/',
    page_title: trimText(row?.page_title, 180) || null,
    referrer_path: cleanPath(row?.referrer_path) || null,
    metadata_summary: properties.entries,
    metadata_keys: properties.keys,
    utm_summary: utm.entries,
    utm_keys: utm.keys,
    occurred_at: trimText(row?.occurred_at, 40) || null,
    created_at: trimText(row?.created_at, 40) || null,
  };
}

function paginate(rows, page, limit) {
  const items = rows.slice(0, limit);
  return {
    page,
    limit,
    returned: items.length,
    has_more: rows.length > limit,
  };
}

function buildSummary(leadRows, eventRows) {
  const leadCounts = {
    submitted: 0,
    partial: 0,
    abandoned: 0,
  };
  for (const row of leadRows) {
    const status = trimText(row?.status, 40).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(leadCounts, status)) leadCounts[status] += 1;
  }
  const pageCounts = {};
  let recentActivityAt = '';
  for (const event of eventRows) {
    const path = cleanPath(event?.path) || '/';
    pageCounts[path] = (pageCounts[path] || 0) + 1;
    const occurredAt = trimText(event?.occurred_at || event?.created_at, 40);
    if (occurredAt && (!recentActivityAt || occurredAt > recentActivityAt)) recentActivityAt = occurredAt;
  }
  for (const lead of leadRows) {
    const updatedAt = trimText(lead?.updated_at || lead?.submitted_at || lead?.created_at, 40);
    if (updatedAt && (!recentActivityAt || updatedAt > recentActivityAt)) recentActivityAt = updatedAt;
  }
  const mostActivePage = Object.entries(pageCounts)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([path, count]) => ({ path, display_name: pageDisplayName(path), count }))
    .at(0) || null;
  return {
    submitted_leads: leadCounts.submitted,
    draft_or_partial_leads: leadCounts.partial + leadCounts.abandoned,
    partial_leads: leadCounts.partial,
    abandoned_leads: leadCounts.abandoned,
    public_analytics_events: eventRows.length,
    most_active_page: mostActivePage,
    recent_activity_at: recentActivityAt || null,
    sampled: leadRows.length >= SUMMARY_LIMIT || eventRows.length >= SUMMARY_LIMIT,
  };
}

function buildPageActivitySummary(leadRows, eventRows) {
  const pages = new Map();
  const ensure = (path) => {
    const clean = cleanPath(path) || '/';
    if (!pages.has(clean)) {
      pages.set(clean, {
        path: clean,
        display_name: pageDisplayName(clean),
        event_count: 0,
        page_views: 0,
        cta_clicks: 0,
        form_activity: 0,
        lead_count: 0,
        submitted_leads: 0,
        draft_or_partial_leads: 0,
        last_activity_at: null,
      });
    }
    return pages.get(clean);
  };

  for (const event of eventRows) {
    const page = ensure(event?.path);
    const eventName = trimText(event?.event_name, 100);
    page.event_count += 1;
    if (eventName === 'page_viewed') page.page_views += 1;
    if (eventName === 'cta_clicked') page.cta_clicks += 1;
    if (eventName.startsWith('lead_form_') || eventName.startsWith('lead_draft_')) page.form_activity += 1;
    page.last_activity_at = latestIso(page.last_activity_at, event?.occurred_at, event?.created_at) || null;
  }

  for (const lead of leadRows) {
    const page = ensure(lead?.source_path);
    const status = trimText(lead?.status, 40).toLowerCase();
    page.lead_count += 1;
    if (status === 'submitted') page.submitted_leads += 1;
    if (status === 'partial' || status === 'abandoned') page.draft_or_partial_leads += 1;
    page.last_activity_at = latestIso(page.last_activity_at, lead?.updated_at, lead?.submitted_at, lead?.created_at) || null;
  }

  return Array.from(pages.values())
    .sort((left, right) => {
      const activityDelta = Number(right.event_count + right.lead_count) - Number(left.event_count + left.lead_count);
      if (activityDelta !== 0) return activityDelta;
      return String(right.last_activity_at || '').localeCompare(String(left.last_activity_at || ''));
    })
    .slice(0, 8);
}

function buildEventTypeSummary(eventRows) {
  const counts = {};
  for (const event of eventRows) {
    const eventName = trimText(event?.event_name, 100) || 'unknown';
    incrementCount(counts, eventName);
  }
  return Object.entries(counts)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 10)
    .map(([event_name, count]) => ({
      event_name,
      display_name: eventDisplayName(event_name),
      count,
    }));
}

function buildCtaActivitySummary(eventRows) {
  const ctas = new Map();
  for (const event of eventRows) {
    if (trimText(event?.event_name, 100) !== 'cta_clicked') continue;
    const properties = event?.properties && typeof event.properties === 'object' ? event.properties : {};
    const label = safeSummaryText(properties.cta_label, 'Unknown CTA');
    const placement = safeSummaryText(properties.placement, 'Unknown placement');
    const targetPath = cleanPath(properties.cta_target) || safeSummaryText(properties.cta_target, 'Unknown target');
    const key = `${label}|${placement}|${targetPath}`;
    const existing = ctas.get(key) || {
      label,
      placement,
      target_path: targetPath,
      count: 0,
      last_clicked_at: null,
    };
    existing.count += 1;
    existing.last_clicked_at = latestIso(existing.last_clicked_at, event?.occurred_at || event?.created_at) || null;
    ctas.set(key, existing);
  }
  return Array.from(ctas.values())
    .sort((left, right) => {
      const countDelta = Number(right.count) - Number(left.count);
      if (countDelta !== 0) return countDelta;
      return String(right.last_clicked_at || '').localeCompare(String(left.last_clicked_at || ''));
    })
    .slice(0, 8);
}

function buildFormActivitySummary(leadRows, eventRows) {
  const forms = new Map();
  const ensure = (formId, formType = '', productInterest = '') => {
    const safeFormId = safeSummaryText(formId, 'unknown-form');
    const safeFormType = safeSummaryText(formType, 'unknown');
    const safeProductInterest = safeSummaryText(productInterest, '');
    const key = `${safeFormId}|${safeFormType}|${safeProductInterest}`;
    if (!forms.has(key)) {
      forms.set(key, {
        form_id: safeFormId,
        form_type: safeFormType,
        product_interest: safeProductInterest || null,
        event_count: 0,
        viewed: 0,
        started: 0,
        submitted_events: 0,
        abandoned_events: 0,
        draft_saved_events: 0,
        lead_count: 0,
        submitted_leads: 0,
        draft_or_partial_leads: 0,
        last_activity_at: null,
      });
    }
    return forms.get(key);
  };

  for (const event of eventRows) {
    const eventName = trimText(event?.event_name, 100);
    if (!eventName.startsWith('lead_form_') && !eventName.startsWith('lead_draft_')) continue;
    const properties = event?.properties && typeof event.properties === 'object' ? event.properties : {};
    const form = ensure(properties.form_id, properties.form_type);
    form.event_count += 1;
    if (eventName === 'lead_form_viewed') form.viewed += 1;
    if (eventName === 'lead_form_started') form.started += 1;
    if (eventName === 'lead_form_submit_succeeded') form.submitted_events += 1;
    if (eventName === 'lead_form_abandoned') form.abandoned_events += 1;
    if (eventName === 'lead_draft_saved') form.draft_saved_events += 1;
    form.last_activity_at = latestIso(form.last_activity_at, event?.occurred_at, event?.created_at) || null;
  }

  for (const lead of leadRows) {
    const form = ensure(lead?.form_id, lead?.form_type, lead?.product_interest);
    const status = trimText(lead?.status, 40).toLowerCase();
    form.lead_count += 1;
    if (status === 'submitted') form.submitted_leads += 1;
    if (status === 'partial' || status === 'abandoned') form.draft_or_partial_leads += 1;
    form.last_activity_at = latestIso(form.last_activity_at, lead?.updated_at, lead?.submitted_at, lead?.created_at) || null;
  }

  return Array.from(forms.values())
    .sort((left, right) => {
      const activityDelta = Number(right.lead_count + right.event_count) - Number(left.lead_count + left.event_count);
      if (activityDelta !== 0) return activityDelta;
      return String(right.last_activity_at || '').localeCompare(String(left.last_activity_at || ''));
    })
    .slice(0, 8);
}

function buildInsights(leadRows, eventRows) {
  return {
    page_activity: buildPageActivitySummary(leadRows, eventRows),
    event_types: buildEventTypeSummary(eventRows),
    cta_activity: buildCtaActivitySummary(eventRows),
    form_activity: buildFormActivitySummary(leadRows, eventRows),
  };
}

function csvCell(value) {
  let text = trimText(value, 500).replace(/\r?\n|\r/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(values) {
  return values.map(csvCell).join(',');
}

function buildLeadCsvRow(lead) {
  const submitted = String(lead.status || '').toLowerCase() === 'submitted';
  return [
    lead.created_at || '',
    lead.updated_at || '',
    lead.status || '',
    submitted ? 'yes' : 'no',
    lead.submitted_at || '',
    pageDisplayName(lead.source?.path),
    lead.source?.path || '/',
    lead.form_id || '',
    lead.form_type || '',
    lead.product_interest || '',
    lead.contact?.full_name || '',
    lead.contact?.first_name || '',
    lead.contact?.last_name || '',
    lead.contact?.email || '',
    lead.contact?.phone || '',
    String(lead.progress?.fields_completed_count || 0),
    Array.isArray(lead.progress?.fields_completed) ? lead.progress.fields_completed.join('; ') : '',
    lead.progress?.last_field || '',
    lead.source?.cta || '',
    lead.message_preview || '',
    lead.archived ? 'archived' : 'active',
    lead.archived_at || '',
    lead.archive_reason || '',
  ];
}

function csvFilename(filters) {
  const from = filters.date_from_display || 'start';
  const to = filters.date_to_display || 'end';
  const status = filters.lead_status || 'all';
  return `public-leads-${from}-to-${to}-${status}-${filters.archive_status}.csv`;
}

async function buildAdminPublicAnalyticsLeadsCsv({ db, query = {}, now = new Date() } = {}) {
  if (!db || typeof db.from !== 'function') {
    const error = new Error('Database client is not configured.');
    error.code = 'public_analytics_db_missing';
    error.status = 503;
    throw error;
  }
  const filters = parseFilters(query, now);
  const rawRows = await readLeadRows(db, filters, { exportRows: true });
  const truncated = rawRows.length > CSV_EXPORT_LIMIT;
  const leads = rawRows.slice(0, CSV_EXPORT_LIMIT).map(sanitizeLead);
  const header = [
    'created_at',
    'updated_at',
    'status',
    'submitted',
    'submitted_at',
    'source_page',
    'source_path',
    'form_id',
    'form_type',
    'product_interest',
    'full_name',
    'first_name',
    'last_name',
    'email',
    'phone',
    'fields_completed_count',
    'fields_completed',
    'last_field',
    'cta',
    'submitted_message_preview_redacted',
    'archive_status',
    'archived_at',
    'archive_reason',
  ];
  return {
    content_type: 'text/csv; charset=utf-8',
    filename: csvFilename(filters),
    row_count: leads.length,
    limit: CSV_EXPORT_LIMIT,
    truncated,
    csv: [
      csvLine(header),
      ...leads.map(buildLeadCsvRow).map(csvLine),
    ].join('\n') + '\n',
  };
}

async function buildAdminPublicAnalyticsPayload({ db, query = {}, now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    const error = new Error('Database client is not configured.');
    error.code = 'public_analytics_db_missing';
    error.status = 503;
    throw error;
  }
  const filters = parseFilters(query, now);
  const [leadRowsRaw, eventRowsRaw, leadSummaryRows, eventSummaryRows] = await Promise.all([
    readLeadRows(db, filters, { page: filters.lead_page, limit: filters.lead_limit }),
    readEventRows(db, filters, { page: filters.event_page, limit: filters.event_limit }),
    readLeadRows(db, filters, { summary: true }),
    readEventRows(db, filters, { summary: true }),
  ]);
  const leadRows = leadRowsRaw.map(sanitizeLead);
  const eventRows = eventRowsRaw.map(sanitizeEvent);
  return {
    generated_at: (now instanceof Date ? now : new Date()).toISOString(),
    filters: {
      date_range: filters.date_range,
      date_from: filters.date_from,
      date_to: filters.date_to,
      date_from_display: filters.date_from_display,
      date_to_display: filters.date_to_display,
      lead_status: filters.lead_status || 'all',
      archive_status: filters.archive_status,
      event_name: filters.event_name || 'all',
      path: filters.path || 'all',
      lead_page: filters.lead_page,
      event_page: filters.event_page,
      lead_limit: filters.lead_limit,
      event_limit: filters.event_limit,
    },
    summary: buildSummary(leadSummaryRows, eventSummaryRows),
    insights: buildInsights(leadSummaryRows, eventSummaryRows),
    leads: {
      items: leadRows.slice(0, filters.lead_limit),
      pagination: paginate(leadRowsRaw, filters.lead_page, filters.lead_limit),
    },
    events: {
      items: eventRows.slice(0, filters.event_limit),
      pagination: paginate(eventRowsRaw, filters.event_page, filters.event_limit),
    },
    request_id: requestId || null,
  };
}

function publicAnalyticsServiceError(status, code, detail, requestId = null) {
  const error = new Error(detail || 'Public analytics request failed.');
  error.status = status;
  error.code = code;
  error.request_id = requestId || null;
  return error;
}

async function readLeadForMutation(db, leadId, requestId) {
  const { data, error } = await db
    .from('public_lead_drafts')
    .select(LEAD_SELECT_COLUMNS)
    .eq('id', leadId)
    .maybeSingle();
  if (error) {
    throw publicAnalyticsServiceError(503, 'public_lead_lookup_failed', 'Could not load public lead capture.', requestId);
  }
  if (!data) {
    throw publicAnalyticsServiceError(404, 'public_lead_not_found', 'Public lead capture was not found.', requestId);
  }
  return data;
}

async function updateLeadArchiveState(db, leadId, updates, requestId) {
  const { data, error } = await db
    .from('public_lead_drafts')
    .update(updates)
    .eq('id', leadId)
    .select(LEAD_SELECT_COLUMNS)
    .maybeSingle();
  if (error) {
    throw publicAnalyticsServiceError(503, 'public_lead_archive_failed', 'Could not update public lead capture archive state.', requestId);
  }
  if (!data) {
    throw publicAnalyticsServiceError(404, 'public_lead_not_found', 'Public lead capture was not found.', requestId);
  }
  return data;
}

async function archivePublicLeadCapture({ db, leadId, actorUserId = null, reason = '', now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    throw publicAnalyticsServiceError(503, 'public_analytics_db_missing', 'Database client is not configured.', requestId);
  }
  const id = trimText(leadId, 80);
  if (!UUID_RE.test(id)) {
    throw publicAnalyticsServiceError(400, 'invalid_public_lead_id', 'A valid public lead capture id is required.', requestId);
  }

  const existing = await readLeadForMutation(db, id, requestId);
  if (trimText(existing.archived_at, 40)) {
    return {
      ok: true,
      item: sanitizeLead(existing),
      request_id: requestId || null,
    };
  }

  const archivedAt = (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()).toISOString();
  const updated = await updateLeadArchiveState(db, id, {
    archived_at: archivedAt,
    archived_by_user_id: trimText(actorUserId, 120) || null,
    archive_reason: trimText(reason, 200) || 'Manual admin archive',
  }, requestId);
  return {
    ok: true,
    item: sanitizeLead(updated),
    request_id: requestId || null,
  };
}

async function unarchivePublicLeadCapture({ db, leadId, requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    throw publicAnalyticsServiceError(503, 'public_analytics_db_missing', 'Database client is not configured.', requestId);
  }
  const id = trimText(leadId, 80);
  if (!UUID_RE.test(id)) {
    throw publicAnalyticsServiceError(400, 'invalid_public_lead_id', 'A valid public lead capture id is required.', requestId);
  }

  const existing = await readLeadForMutation(db, id, requestId);
  if (!trimText(existing.archived_at, 40)) {
    return {
      ok: true,
      item: sanitizeLead(existing),
      request_id: requestId || null,
    };
  }

  const updated = await updateLeadArchiveState(db, id, {
    archived_at: null,
    archived_by_user_id: null,
    archive_reason: null,
  }, requestId);
  return {
    ok: true,
    item: sanitizeLead(updated),
    request_id: requestId || null,
  };
}

function normalizeBulkLeadIds(value, requestId) {
  const ids = Array.isArray(value) ? value : [];
  const unique = Array.from(new Set(ids.map((id) => trimText(id, 80)).filter(Boolean)));
  if (unique.length === 0) {
    throw publicAnalyticsServiceError(400, 'public_lead_ids_required', 'At least one public lead capture id is required.', requestId);
  }
  if (unique.length > BULK_ARCHIVE_LIMIT) {
    throw publicAnalyticsServiceError(400, 'too_many_public_lead_ids', `Select ${BULK_ARCHIVE_LIMIT} or fewer lead captures at a time.`, requestId);
  }
  if (unique.some((id) => !UUID_RE.test(id))) {
    throw publicAnalyticsServiceError(400, 'invalid_public_lead_id', 'All public lead capture ids must be valid ids.', requestId);
  }
  return unique;
}

async function updatePublicLeadCaptureArchiveBatch({
  db,
  leadIds,
  archive = true,
  actorUserId = null,
  reason = '',
  now = new Date(),
  requestId = null,
} = {}) {
  if (!db || typeof db.from !== 'function') {
    throw publicAnalyticsServiceError(503, 'public_analytics_db_missing', 'Database client is not configured.', requestId);
  }
  const ids = normalizeBulkLeadIds(leadIds, requestId);
  const archivedAt = (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()).toISOString();
  let updatedCount = 0;
  let skippedCount = 0;

  for (const id of ids) {
    const existing = await readLeadForMutation(db, id, requestId);
    const isArchived = Boolean(trimText(existing.archived_at, 40));
    if (archive && isArchived) {
      skippedCount += 1;
      continue;
    }
    if (!archive && !isArchived) {
      skippedCount += 1;
      continue;
    }
    await updateLeadArchiveState(db, id, archive ? {
      archived_at: archivedAt,
      archived_by_user_id: trimText(actorUserId, 120) || null,
      archive_reason: trimText(reason, 200) || 'Manual admin archive',
    } : {
      archived_at: null,
      archived_by_user_id: null,
      archive_reason: null,
    }, requestId);
    updatedCount += 1;
  }

  return {
    ok: true,
    requested_count: ids.length,
    updated_count: updatedCount,
    skipped_count: skippedCount,
    request_id: requestId || null,
  };
}

function safePublicAnalyticsErrorBody(error, requestId) {
  return {
    error: error?.code || 'admin_public_analytics_failed',
    code: error?.code || 'admin_public_analytics_failed',
    detail: error?.message || 'Could not load public analytics records.',
    hint: null,
    request_id: requestId || null,
  };
}

module.exports = {
  archivePublicLeadCapture,
  BULK_ARCHIVE_LIMIT,
  buildAdminPublicAnalyticsLeadsCsv,
  buildAdminPublicAnalyticsPayload,
  CSV_EXPORT_LIMIT,
  parseFilters,
  safePublicAnalyticsErrorBody,
  sanitizeEvent,
  sanitizeLead,
  buildInsights,
  unarchivePublicLeadCapture,
  updatePublicLeadCaptureArchiveBatch,
};

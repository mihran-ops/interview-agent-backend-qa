'use strict';

// Tenancy helpers shared across the client-scoped and admin surfaces.

function uniqueClientIds(ids) {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean)))
}

module.exports = { uniqueClientIds };

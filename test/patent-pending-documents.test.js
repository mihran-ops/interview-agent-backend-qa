'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const { buildMembershipAgreementHtml } = require('../src/render/membershipAgreement')
const { buildCandidateReportHtml } = require('../src/render/candidateReport')

const root = path.join(__dirname, '..')
const securityOverview = fs.readFileSync(
  path.join(root, 'templates', 'pdf', 'alphascreen-security-data-protection-overview.html'),
  'utf8'
)
const gettingStartedPlaybook = fs.readFileSync(
  path.join(root, 'templates', 'email-attachments', 'alphascreen-getting-started-playbook-source', 'playbook.html'),
  'utf8'
)
const candidateReportMark = fs.readFileSync(
  path.join(root, 'templates', 'pdf', 'assets', 'alphascreen-mark-08-navy.svg'),
  'utf8'
)

function count(value, phrase) {
  return String(value).split(phrase).length - 1
}

test('new membership agreements include the scoped Section 10 sentence once', () => {
  const { html } = buildMembershipAgreementHtml({
    client_legal_name: 'Synthetic Dental Group',
    primary_admin_name: 'Casey Reviewer',
    admin_email: 'casey@example.test',
    membership_tier: 'basic',
    initial_term_start: '2026-08-20',
    initial_renewal_date: '2027-08-20',
    billing_option: 'monthly'
  })

  assert.equal(count(html, 'Certain alphaScreen technologies are patent pending.'), 1)
  assert.match(html, /10\. Intellectual Property[\s\S]*Certain alphaScreen technologies are patent pending\./)
})

test('new candidate reports use the static alphaScreen vector lockup and one secondary first-page notice', () => {
  const html = buildCandidateReportHtml({
    name: 'Synthetic Candidate',
    email: 'candidate@example.test',
    company_name: 'Synthetic Company',
    role_name: 'Synthetic Role',
    resume_score: 82,
    interview_score: 86,
    overall_score: 84
  })

  assert.equal(count(html, 'alphaScreen technology — Patent Pending'), 1)
  assert.match(html, /data:image\/svg\+xml;base64,/)
  assert.match(html, /class="brand-wordmark">alphaScreen<\/div>/)
  assert.match(html, /<h2>Candidate Report<\/h2>\s*<p class="patent-notice">alphaScreen technology — Patent Pending<\/p>/)
  assert.match(html, /\.patent-notice[\s\S]*font-size: 11px/)
  assert.match(candidateReportMark, /<path\b/)
  assert.doesNotMatch(candidateReportMark, /<image\b|data:image/i)
})

test('the security overview cover includes one compact approved badge', () => {
  assert.equal(count(securityOverview, 'Patent Pending'), 1)
  assert.match(securityOverview, /Client-Facing Product Security Summary<\/p>\s*<p class="patent-notice">Patent Pending<\/p>/)
})

test('the Getting Started playbook source includes one cover-only notice', () => {
  assert.equal(count(gettingStartedPlaybook, 'Patent Pending'), 1)
  assert.match(gettingStartedPlaybook, /alphaScreen by alphaSource<\/div>\s*<div class="patent-pending">Patent Pending<\/div>/)
})

test('document sources contain no prohibited patent claim or identifier pattern', () => {
  const sources = [
    buildMembershipAgreementHtml({}).html,
    buildCandidateReportHtml({}),
    securityOverview,
    gettingStartedPlaybook
  ].join('\n')

  assert.doesNotMatch(sources, /patent protected|USPTO approved|patent granted|proprietary patented technology/i)
  assert.doesNotMatch(sources, /\b(?:application|receipt|patent)\s*(?:no\.?|number|#)\s*[:#-]?\s*[A-Z0-9]/i)
  assert.doesNotMatch(sources, /[™®]/)
})

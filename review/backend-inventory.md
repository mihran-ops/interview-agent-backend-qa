# Backend inventory

**Repository:** interview-agent-backend
**Tree analysed:** 8cf8f9b (the commit review/refactor-survey.md documents), cross-checked
against 7bb90c3 (the last commit before the refactor began)
**Date:** 2026-09-16
**Status:** Read-only analysis.

> **This file did not exist before 2026-09-16.** The review task assumed a prior
> `review/backend-inventory.md` with a "Dead code candidates" section and a section 4 to be
> corrected in place. No such file exists in the working tree or in any commit on any branch
> — `git log --all -- "*backend-inventory*"` returns nothing, and there has never been a
> `review/proposed/` directory. The only document that made dead-code claims is
> review/refactor-survey.md section 2.1, and that is where the corrections were applied.
> This file was created to hold the verified results, the two findings, and the corrections
> list. Nothing here overwrites earlier analysis, because there was none.

---

## 1. Method

Reachability was determined by building a require() dependency graph, not by name search.
Name search is what produced the errors listed in section 5: a string like `auth` or
`createTavusInterview` appears in dozens of unrelated files, so counting occurrences says
nothing about whether a module is loaded.

The graph is built as follows.

- **Edges.** Every `require('...')` and `require.resolve('...')` with a relative string
  literal, wherever it appears in the file — module scope or inside a function body. Inline
  requires inside handlers are counted; several live modules are reached only that way.
- **Resolution.** A specifier resolves to `<target>`, `<target>.js`, or
  `<target>/index.js`, whichever exists.
- **Roots.** Runtime reachability starts at `app.js` alone. Test reachability starts at
  every file under `test/`. Script reachability starts at every file under `scripts/`.
- **Status.** `live` = reachable from app.js. `test-only` = reachable from `test/` but not
  from app.js. `unreachable` = reached by no root.

**Completeness of the runtime graph.** A static graph is only trustworthy if nothing in the
runtime path requires a computed path. Computed calls — `require(variable)`,
`require(path.join(...))` — were counted separately. There are **none in runtime code**.
All 27 computed calls are in `test/` (25) and `scripts/verify-routes.js` (2), where tests
resolve module paths to inject stubs. The runtime reachability result is therefore complete,
not a lower bound.

**Stability across commits.** The same graph was built at 8cf8f9b and at 7bb90c3. No file
present in both trees changes status between them. The ten differences are all files added
between the two commits. Every verdict below holds for both.

Per-file results: review/dead-code-verified.csv.

---

## 2. Totals

| Status | Files | Lines |
|---|---:|---:|
| live (reachable from app.js) | 128 | — |
| test-only | 122 | — |
| script-only (own entry point) | 7 | — |
| unreachable | 20 | 1,382 |
| **total .js analysed** | **277** | |

`test-only` is dominated by the 117 test files themselves. Only five non-test modules fall
in that class; they are listed in section 4.

`script-only` files are entry points invoked directly or through npm scripts, not dead code.
They are excluded from the dead-code question rather than counted as unreachable.

---

## 3. Dead code candidates, verified

All 20 files unreachable from app.js.

| Path | Lines | Note |
|---|---:|---|
| handlers/recordingReady.js | 497 | requires `../supabaseClient` and `../utils/pdfMonkey`; neither exists |
| handlers/resumeUpload.js | 132 | not named in the earlier survey |
| jobs/sendNightlyDigests.js | 99 | requires `../supabaseClient`; does not exist |
| routes/candidates.js | 96 | router never mounted |
| lib/tavusClient.js | 89 | |
| handlers/tavusWebhook.js | 89 | |
| createTavusInterview.js | 72 | root-level; superseded by routes/createTavusInterview.js |
| lib/createTavusInterviewInternal.js | 70 | requires `./supabaseClient`; does not exist |
| handlers/createPaymentIntent.js | 59 | |
| utils/pg.js | 39 | requires `pg`, absent from package.json |
| utils/sendEmailOtp.js | 37 | |
| routes/authPing.js | 32 | router never mounted; not named in the earlier survey |
| test-upload.js | 23 | root-level scratch script |
| testResumeAnalysis.js | 22 | root-level scratch script |
| config/storage.js | 9 | |
| test-utc.js | 7 | root-level scratch script |
| src/middleware/requireAuth.js | 4 | re-export shim |
| src/middleware/withClientScope.js | 4 | re-export shim |
| handlers/generateReport.js | 1 | |
| middleware/auth.js | 1 | re-export shim |

Three of these fail independently of reachability. Each requires a module that exists
nowhere in the repository:

- handlers/recordingReady.js:12 requires `../supabaseClient`
- handlers/recordingReady.js:13 requires `../utils/pdfMonkey`
- jobs/sendNightlyDigests.js:2 requires `../supabaseClient`
- lib/createTavusInterviewInternal.js:2 requires `./supabaseClient`

They would throw MODULE_NOT_FOUND if anything did reach them, which confirms by a second
route that nothing does.

---

## 4. Reachable only from test/

Five non-test modules are reached from `test/` but never from app.js. They are not dead in
the sense of being deletable — deleting them breaks the suite — but they are not part of the
running service either, and any claim that `src/lib/` is "nearly all live" should exclude
them.

| Path | Lines | First requirer |
|---|---:|---|
| src/lib/tavusPronunciationSync.js | 188 | test/tavus-pronunciation-sync.test.js |
| src/lib/pronunciationRegistry.js | 136 | test/pronunciation-registry.test.js |
| src/lib/pronunciationDiscovery.js | 75 | test/pronunciation-discovery.test.js |
| src/data/pronunciation/dentalSeed.js | 64 | test/pronunciation-registry.test.js |
| src/lib/smsDeliveryCallbackContract.js | 35 | test/sms-c0-contract.test.js |

---

## 5. Findings

### 5.1 GET /:token does not swallow /healthz or /health

The catch-all `GET /:token` is registered at app.js:6716, ahead of `/healthz` at app.js:6734
and `/health` at app.js:6812. Express matches in registration order, so the health endpoints
depend on the catch-all declining them. It declines: the handler calls `next()` unless the
Host header is the interviews subdomain *and* the token matches a v4 UUID. Neither `healthz`
nor `health` is a UUID, so both fall through to their own handlers.

Verified behaviourally by test/app.smoke.test.js, which asserts that `GET /healthz` returns
its documented payload and `GET /health` returns `{ ok: true }`. Both pass.

The earlier caveat in review/refactor-survey.md section 1.3 item 2 — that this "must be
confirmed behaviourally before any reordering" — has been removed. It is confirmed.

### 5.2 npm test does not terminate, which blocks CI

`npm test` runs `node --test test/*.test.js` and never exits.
test/support-voice-websocket.test.js leaves a handle open after its assertions finish, so
the runner waits on that worker indefinitely. Observed on Windows; two full-suite runs were
killed after 22 minutes with no further output, and a bounded re-run of that file alone exits
124 (killed by timeout) rather than reporting a result.

The file does call `h.close()` in its test bodies, so the leak is a socket or timer that
close does not cover, not a missing teardown call.

Consequence: **any CI job that runs `npm test` will hang until the job timeout and then fail,
regardless of whether the tests pass.** There is no green path until this is fixed. Until
then the suite must be run per file, each in its own bounded process, treating a non-zero
exit and a timeout as distinct outcomes.

This is a prerequisite for CI, not a nice-to-have.

---

## 6. Corrections — 2026-09-16

Corrections to review/refactor-survey.md section 2.1, which was the only document making
dead-code claims. Each was wrong because it rested on a name search rather than a
dependency graph.

1. **handlers/createTavusInterview.js — claimed "imported only by a test", actually live.**
   Required at routes/createTavusInterview.js:7. 463 lines. The survey's handlers/ row said
   "none reachable"; one of the six is reachable, and it is the largest live file in the
   directory. Acting on the original claim by deleting `handlers/` wholesale would have
   taken the create-interview route down.

2. **src/lib/platformHealth/index.js — claimed dead ("barrel; tests import the leaves
   directly"), actually live.** Required at src/lib/adminMetricsService.js:4. 74 lines. The
   tests do import the leaves directly, which is what the name search saw; the barrel has a
   separate production requirer that the search missed.

3. **middleware/auth.js — claimed live, actually unreachable.** The survey's `middleware/`
   row listed it under Live as a "1-line re-export" with no dead entry. Nothing requires it.
   The re-export is real; the consumption is not.

4. **handlers/resumeUpload.js — unreachable, not listed at all.** 132 lines. The survey's
   handlers/ row named four dead files and accounted for five of six; this is the sixth.

5. **routes/authPing.js — unreachable, not listed at all.** 32 lines. Never mounted. Sits
   outside the six directories section 2.1 covers, so it escaped the survey's framing
   entirely.

6. **routes/candidates.js — unreachable, not listed at all.** 96 lines. Never mounted. Same
   gap as above.

7. **createTavusInterview.js (root), test-upload.js, test-utc.js, testResumeAnalysis.js —
   unreachable, not listed at all.** 124 lines together. Root-level files outside every
   directory the survey tabulated.

8. **src/lib/ — claimed "nearly all" live with one dead file; actually all live, with five
   test-only.** No file in src/lib/ is unreachable. Five are reached only from `test/` and
   are listed in section 4. The row was wrong in both directions: the one file it called
   dead is live, and five files it implied were live are not part of the running service.

9. **lib/stripeClient.js — the "unused by app.js" note was literally true but misleading.**
   app.js does not require it; routes/adminBilling.js does, so it is live. Now states the
   real requirer.

10. **"roughly 1,200 lines of unreachable code" — imprecise and applied to the wrong set.**
    Within the directories proposed for deletion, 1,130 lines across 14 files are
    unreachable; the remaining files in those directories are live and must be moved. Across
    the whole repository the figure is 1,382 lines across 20 files. The original sentence
    also said those directories were "deleted outright", which would have deleted live code.

Claims checked and confirmed correct, left unchanged: src/middleware/requireAuth.js and
src/middleware/withClientScope.js dead; lib/tavusClient.js and
lib/createTavusInterviewInternal.js dead; utils/pg.js and utils/sendEmailOtp.js dead;
config/storage.js dead; jobs/sendNightlyDigests.js dead; handlers/recordingReady.js,
handlers/tavusWebhook.js, handlers/createPaymentIntent.js and handlers/generateReport.js
dead; and every file listed in the Live column of the utils/, config/ and lib/ rows.

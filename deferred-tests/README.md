# Deferred integration tests

These suites came from the `origin/main` autopilot/scheduler line (PR #1). They test
server behavior written against the pre-separation model — `@mention` messages that
create tasks, `accessMode` on the message API, per-agent concurrent runs, and the
`schedulePass`/`retryTask`/autopilot wiring that lived in that version of
`src/server.js`.

The chat/board separation merge kept that line's compatible pieces (process-manager
reserve/release + cancel reasons, broadened redaction, store hardening, CSRF guards,
and the pure `src/lib/policy.js` / `src/lib/scheduler.js` modules with
`test/policy.test.js`). The autopilot and dependency-scheduler **server wiring** was
deliberately not merged: it conflicts with the chat-turn model and the PRD's
one-run-per-agent rule (§4.7), and re-integrating it is its own task.

When that integration task happens (see COORDINATION.md), port these suites to the
chat-turn model and move them back into `test/` so `node --test` picks them up.
They are named `*.integration.js` on purpose — the test runner must not run them
against the current server, where they would fail by design.

# Deferred integration tests — ported

The suites that lived here (`autopilot.integration.js`, `scheduler.integration.js`,
`regression.integration.js`, from the `origin/main` autopilot line, PR #1) have been
ported to the chat-turn server model and now run under `node --test` as
`test/autopilot.test.js` and `test/dependencies.test.js` (COORDINATION.md open item 8).
The port keeps the current vocabulary — `ready` is the queued-eligible state, one run
per agent, one direct writer — and drops the pre-separation assumptions (`@mention`
tasks, `accessMode` on messages, per-agent concurrent runs) the originals were
written against.

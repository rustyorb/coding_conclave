# Agent Coordination Protocol

This workspace is shared by multiple coding agents (Claude, Codex, Gemini) run by the
Conclave app in this repo. Every agent run MUST follow this protocol.

## Before doing anything

1. Read `COORDINATION.md`. It lists which files other agents have claimed and the most
   recent handoffs.
2. Run `git status` and `git log --oneline -5`. Uncommitted changes you did not make
   belong to another agent — do not modify, revert, or commit those files.

## While working

- Claim your work: add a row to the **Active claims** table in `COORDINATION.md` with
  your agent id, the files you will touch, and your task, before editing them.
- Stay off files claimed by another agent. If your task requires a claimed file, stop
  and report the conflict in your handoff instead of editing it.
- Never run destructive git commands (`reset --hard`, `checkout --`, `clean`, force
  push). Another agent's in-progress work may be in the tree.

## When finishing

1. Remove your row from **Active claims**.
2. Add an entry at the top of **Handoffs** in `COORDINATION.md`: what changed, which
   files, how to verify (exact commands), and anything left open.
3. End your reply with the same handoff so the operator and the next agent see it in
   the room feed.

## Ground rules

- One task per run; do not expand scope into another agent's task.
- Validate with `npm test` before reporting done when you touched `src/` or `test/`.
- Report only what actually happened.

# Developer index

Entry point for working on omp-teams. User-facing usage lives in [README](../README.md); this
page only indexes code, tests and commands, and points at the files that define each behaviour.

## Layout

| Area | Files |
|---|---|
| storage and schema | [src/db.ts](../src/db.ts) |
| project identity, rank labels, session tags | [src/identity.ts](../src/identity.ts) |
| members, seats, groups, liveness | [src/registry.ts](../src/registry.ts) |
| mailbox and delivery policy | [src/mail.ts](../src/mail.ts) |
| task state machine and claim | [src/queue.ts](../src/queue.ts) |
| worker and integrator slots | [src/slots.ts](../src/slots.ts) |
| configuration and model routing | [src/config.ts](../src/config.ts) |
| git worktrees and merges | [src/worktree.ts](../src/worktree.ts), [src/merge.ts](../src/merge.ts) |
| tool-call guards per role | [src/policy.ts](../src/policy.ts) |
| brakes, spend ledger, price fallback | [src/guard.ts](../src/guard.ts) |
| assignment, reports, patrol, closing | [src/runtime.ts](../src/runtime.ts) |
| herdr client and layout | [src/herdr.ts](../src/herdr.ts), [src/spawn.ts](../src/spawn.ts) |
| status line, widget, tree overlay | [src/presence.ts](../src/presence.ts), [src/tree.ts](../src/tree.ts) |
| daily report and audit export | [src/report.ts](../src/report.ts) |
| `/teams resume` machine recovery | [src/rebuild.ts](../src/rebuild.ts) |
| `/teams` surface and agent tools | [src/commands.ts](../src/commands.ts), [src/tools.ts](../src/tools.ts) |
| host interface and entry point | [src/host.ts](../src/host.ts), [src/index.ts](../src/index.ts) |

## Verify

| Command | Covers |
|---|---|
| `./node_modules/.bin/tsc --noEmit` | types for `src`, `test`, `scripts` |
| `bun test` | unit suites in [test/](../test) |
| `bun run test:e2e` | real `omp --mode rpc` tree: registration, delivery, restart ([scripts/e2e-smoke.ts](../scripts/e2e-smoke.ts)) |
| `bun run test:herdr` | layout, ranks, panes, worktrees ([scripts/herdr-smoke.ts](../scripts/herdr-smoke.ts)) |
| `bun run test:herdr:m2` | queue, integrator, pause, restart, retire ([scripts/herdr-m2.ts](../scripts/herdr-m2.ts)) |
| `bun run test:herdr:ui` | status line, widget, tree overlay keys ([scripts/herdr-ui.ts](../scripts/herdr-ui.ts)) |
| `bun run test:herdr:auto` | one sentence to the personal leader, outcome checks ([scripts/herdr-auto.ts](../scripts/herdr-auto.ts)) |
| `MODE=guards\|budget\|rebuild\|fresh\|bootstrap bun scripts/herdr-m3.ts` | brakes, halt/resume, rebuild, fresh status, bootstrap |

The herdr suites need a herdr pane and open their own temporary workspaces with an isolated
state directory. `KEEP=1` keeps the tree and panes for inspection; without it everything is
closed and removed. Shared helpers live in [scripts/harness.ts](../scripts/harness.ts).

`test:herdr:auto` and the M3 modes spend real tokens.

## Conventions

Project rules live in `AGENTS.md` (local, not published); `CLAUDE.md` links to it. Project
skills live in `.agents/skills/`, with `.claude/skills` and `.codex/skills` as links to the
same directory.

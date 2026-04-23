# Paperclip — Claude Code Handbook

**Canonical publish: `publishForCurrentPhase()` — jediná cesta pro workflow artifacty.**

## Quick Ref

| Phase | Role | Artifact | Přechází do |
|-------|------|----------|-------------|
| planning | planner | `{ plan: { goals, tasks } }` | plan_review |
| plan_review | plan_reviewer | `{ verdict, feedback }` | executing / planning |
| executing | executor | `{ changes, completedTasks }` | code_review |
| code_review | reviewer | `{ verdict, comments }` | integration / executing |
| integration | integrator | `{ merged, notes }` | — |

Bounce limit: 3 backward transitions. Rework limit: 2 artifacty per phase.

## Canonical Publish Path

```typescript
import { publishForCurrentPhase } from "./services/issue-artifacts.js";

const artifact = await publishForCurrentPhase(
  db, companyId, "planner",
  { issueId: "..." },
  agentId,  // volitelné
  summary,  // volitelné
);
```

Atomicky: validuje phase↔role kompatibilitu → nahradí předchozí artifact stejného typu → spustí `orchestrateIssue()`.

**Nikdy** nevol `replace()`, `create()`, `publish()` přímo na `issueArtifactService`.

## Role Usage Patterns

```typescript
// PLANNER — vytvoř plán
await publishForCurrentPhase(db, companyId, "planner", {
  issueId, plan: { goals: [...], tasks: [...] },
});

// PLAN_REVIEWER — schvalení plánu
await publishForCurrentPhase(db, companyId, "plan_reviewer", {
  issueId, verdict: "approved" | "rejected", feedback: "...",
});

// EXECUTOR — proveď změny
await publishForCurrentPhase(db, companyId, "executor", {
  issueId, changes: [{ file: "...", diff: "..." }], completedTasks: [...],
});

// REVIEWER — code review
await publishForCurrentPhase(db, companyId, "reviewer", {
  issueId, verdict: "approved" | "changes_requested", comments: [...],
});

// INTEGRATOR — merge
await publishForCurrentPhase(db, companyId, "integrator", {
  issueId, merged: boolean, notes: "...",
});
```

## Orchestration Decisions

Po každém `publishForCurrentPhase()` běží `orchestrateIssue()` a vrací:

- `phase_transition` — posun do další fáze
- `reassign` — přesměrování agenta
- `mark_blocked` — zastaveno (bounce/rework limit)
- `mark_ready_for_execution` — vstup do exekuční pipeline
- `noop` — nic

## Architecture Hot Spots

| File | Purpose |
|------|---------|
| `server/src/services/issue-artifacts.ts` | Artifact lifecycle — pouze `publishForCurrentPhase()` |
| `server/src/services/swarm-orchestrator.ts` | Rozhodovací vrstva po každém publish — `orchestrateIssue()` |
| `server/src/services/issue-phase.ts` | Phase transition validation |
| `server/src/services/heartbeat.ts` | Heartbeat processing (velký, aktivní) |
| `server/src/services/issues.ts` | Core issue CRUD a workflow (velký) |

## Repo Map

- `server/` — Express API + services
- `ui/` — React board UI
- `packages/db/` — Drizzle schema
- `packages/shared/` — types, constants
- `packages/adapters/` — Claude, Codex, Cursor adapters

## Dev Commands

```sh
pnpm dev          # API + UI na :3100
pnpm test         # Vitest suite
pnpm test:e2e     # Browser e2e (opt-in)
pnpm db:generate  # Generate migration po změně schématu
```

## Key Constraint

Changes must be company-scoped. Every entity is scoped to a company.

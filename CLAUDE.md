# CLAUDE.md

Quick reference for Claude Code agents working in this repo.

## Canonical Publish Path

**Use `publishForCurrentPhase()` — the ONLY entrypoint for workflow artifacts.**

```typescript
import { publishForCurrentPhase } from "./services/issue-artifacts.js";

const artifact = await publishForCurrentPhase(
  db,
  companyId,
  "planner", // | "plan_reviewer" | "executor" | "reviewer" | "integrator"
  { issueId: "..." },
  agentId,   // optional
  summary,   // optional
);
```

This atomically: validates phase↔role compatibility → replaces prior artifact of same type → triggers orchestration.

**Never call** `replace()`, `create()`, or `publish()` directly on `issueArtifactService`.

## Phase → Role Mapping

| Phase | Role | Artifact Type |
|-------|------|---------------|
| planning | planner | planner |
| plan_review | plan_reviewer | plan_reviewer |
| executing | executor | executor |
| code_review | reviewer | reviewer |
| integration | integrator | integrator |

## Architecture Hot Spots

| File | Purpose |
|------|---------|
| `server/src/services/issue-artifacts.ts` | Artifact lifecycle — use `publishForCurrentPhase()` |
| `server/src/services/swarm-orchestrator.ts` | Decision layer after every publish — `orchestrateIssue()` |
| `server/src/services/issue-phase.ts` | Phase transition validation |
| `server/src/services/heartbeat.ts` | Run heartbeat processing (large, active) |
| `server/src/services/issues.ts` | Core issue CRUD and workflow (large) |

## Role Usage Patterns

### planner
```typescript
await publishForCurrentPhase(db, companyId, "planner", {
  issueId,
  plan: { goals: [...], tasks: [...] },
});
```

### plan_reviewer
```typescript
await publishForCurrentPhase(db, companyId, "plan_reviewer", {
  issueId,
  verdict: "approved" | "rejected",
  feedback: "...",
});
```

### executor
```typescript
await publishForCurrentPhase(db, companyId, "executor", {
  issueId,
  changes: [{ file: "...", diff: "..." }],
  completedTasks: [...],
});
```

### reviewer
```typescript
await publishForCurrentPhase(db, companyId, "reviewer", {
  issueId,
  verdict: "approved" | "changes_requested",
  comments: [...],
});
```

### integrator
```typescript
await publishForCurrentPhase(db, companyId, "integrator", {
  issueId,
  merged: boolean,
  notes: "...",
});
```

## Orchestration Decision Types

After every `publishForCurrentPhase()`, `orchestrateIssue()` runs and returns one of:

- `phase_transition` — advance to next phase
- `reassign` — route to different agent
- `mark_blocked` — stop due to bounce/rework limit
- `mark_ready_for_execution` — enter execution pipeline
- `noop` — no action

Bounce limit: 3 consecutive phase transitions. Rework limit: 2 artifacts per phase.

## Repo Map

- `server/` — Express API + services
- `ui/` — React board UI
- `packages/db/` — Drizzle schema
- `packages/shared/` — types, constants
- `packages/adapters/` — Claude, Codex, Cursor adapters

## Dev Commands

```sh
pnpm dev          # API + UI on :3100
pnpm test         # Vitest suite
pnpm test:e2e     # Browser e2e (opt-in)
pnpm db:generate  # Generate migration after schema change
```

## Key Constraint

Changes must be company-scoped. Every entity is scoped to a company.

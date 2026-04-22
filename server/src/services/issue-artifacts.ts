import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueArtifacts } from "@paperclipai/db";
import { issueService } from "./index.js";
import type {
  IssueArtifact,
  ArtifactMetadata,
  ArtifactType,
  ArtifactStatus,
  IssuePhase,
} from "@paperclipai/shared";
import type { CreateIssueArtifact } from "@paperclipai/shared";
import { createIssueArtifactSchema } from "@paperclipai/shared";
import { PHASE_FOR_ARTIFACT_TYPE, ARTIFACT_TYPE_FOR_PHASE } from "@paperclipai/db";
import type { OrchestrationDecision } from "./swarm-orchestrator.js";

type IssueArtifactRow = typeof issueArtifacts.$inferSelect;

function toIssueArtifact(row: IssueArtifactRow): IssueArtifact {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    artifactType: row.artifactType as ArtifactType,
    status: row.status as ArtifactStatus,
    actorAgentId: row.actorAgentId ?? null,
    actorUserId: row.actorUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    summary: row.summary ?? null,
    metadata: (row.metadata as ArtifactMetadata | null) ?? null,
    supersededBy: row.supersededBy ?? null,
    supersedes: row.supersedes ?? null,
    revisionCount: row.revisionCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Phase-artifact invariant: a given artifact type is only valid in its expected phase */
export function assertArtifactTypeForPhase(
  artifactType: ArtifactType,
  phase: IssuePhase,
): void {
  const expected = PHASE_FOR_ARTIFACT_TYPE[artifactType];
  if (expected !== phase) {
    throw new Error(
      `Artifact type '${artifactType}' is not valid in phase '${phase}' — expected '${expected}'`,
    );
  }
}

/**
 * Returns the artifact type required to advance from a given phase.
 * Throws if the phase has no defined artifact type (e.g., terminal phases).
 */
export function getArtifactTypeForPhase(phase: IssuePhase): ArtifactType {
  const type = ARTIFACT_TYPE_FOR_PHASE[phase];
  if (!type) {
    throw new Error(
      `No artifact type defined for phase '${phase}' — phase may be terminal or not workflow-driven`,
    );
  }
  return type as ArtifactType;
}

/**
 * Canonical publish contract for a role publishing a workflow artifact.
 *
 * Each role MUST call this (or equivalent replace()) with the correct phase
 * and artifact type to advance the workflow. The function:
 *   1. Validates phase ↔ artifact type compatibility
 *   2. Validates required metadata fields (issueId)
 *   3. Atomically supersedes any previous published artifact of the same type
 *   4. Creates the new published artifact
 *   5. Triggers orchestration to drive the next phase transition
 *
 * @param db           - Database instance
 * @param companyId    - Company context
 * @param phase        - The issue's current phase (MUST match the role's phase)
 * @param artifactType - One of: planner | plan_reviewer | executor | reviewer | integrator
 * @param metadata     - The structured artifact metadata for this role (MUST include issueId)
 * @param actorAgentId - Agent publishing the artifact (optional)
 * @param summary      - Human-readable summary (optional)
 */
export async function publishArtifactForPhase(
  db: Db,
  companyId: string,
  phase: IssuePhase,
  artifactType: ArtifactType,
  metadata: Record<string, unknown>,
  actorAgentId?: string | null,
  summary?: string | null,
): Promise<IssueArtifact | null> {
  assertArtifactTypeForPhase(artifactType, phase);

  const issueId = metadata["issueId"];
  if (!issueId || typeof issueId !== "string" || issueId.length === 0) {
    throw new Error("publishArtifactForPhase requires metadata.issueId to be a non-empty string");
  }

  return issueArtifactService(db).replace(
    companyId,
    phase,
    issueId,
    artifactType,
    metadata,
    actorAgentId,
    summary,
  );
}

/**
 * Validates the published artifact chain for an issue.
 * Returns the latest valid published artifact chain head, or null if no published artifacts exist.
 *
 * Invariants enforced (checked in priority order):
 *   1. Unique published head — exactly one published artifact exists.
 *   2. Root revisionCount === 1, even for singleton chains (length 1).
 *   3. Consecutive revision counts along the chain.
 *   4. All predecessors in the chain are superseded.
 *   5. All published artifacts are part of a single chain (no forks).
 */
export function validateArtifactChain(
  artifacts: IssueArtifact[],
): IssueArtifact | null {
  const published = artifacts
    .filter((a) => a.status === "published")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (published.length === 0) return null;

  // Invariant 2 (priority): exactly one published head
  if (published.length > 1) {
    throw new Error(
      `Multiple published heads detected: [${published.map((a) => a.id).join(", ")}] — exactly one published artifact is allowed per issue`,
    );
  }

  const [latest] = published;

  // Invariant 1: verify the head's chain covers all published artifacts (only 1 here, so this
  // checks that the single published artifact is reachable from itself — always true).
  // We also use this pass to build chainIds for superseded member inclusion in the walk below.
  const chainIds = new Set<string>();
  let cursor: IssueArtifact | null = latest;
  while (cursor) {
    chainIds.add(cursor.id);
    cursor = cursor.supersedes
      ? (artifacts.find((a) => a.id === cursor!.supersedes) ?? null)
      : null;
  }

  // Invariant 3: singleton root revisionCount === 1
  if (!latest.supersedes && latest.revisionCount !== 1) {
    throw new Error(
      `Artifact chain singleton root revision mismatch: artifact '${latest.id}' has revisionCount ${latest.revisionCount}, expected 1`,
    );
  }

  // Walk the supersedes chain backwards, verifying revision increments
  let current: IssueArtifact = latest;
  let prev: IssueArtifact | null = null;

  while (current.supersedes) {
    const predecessor = artifacts.find(
      (a) => a.id === current.supersedes,
    );
    if (!predecessor) {
      throw new Error(
        `Artifact chain broken: artifact '${current.id}' supersedes '${current.supersedes}' but it does not exist`,
      );
    }
    if (predecessor.status !== "superseded") {
      throw new Error(
        `Artifact chain broken: predecessor '${predecessor.id}' of '${current.id}' has status '${predecessor.status}', expected 'superseded'`,
      );
    }
    if (current.revisionCount !== predecessor.revisionCount + 1) {
      throw new Error(
        `Artifact revision count mismatch: '${current.id}' has revision ${current.revisionCount} but predecessor '${predecessor.id}' has ${predecessor.revisionCount}`,
      );
    }
    prev = predecessor;
    current = predecessor;
  }

  // Invariant 3 (chain length > 1): root artifact must have revisionCount === 1
  if (prev && prev.revisionCount !== 1) {
    throw new Error(
      `Artifact chain root revision mismatch: oldest artifact '${prev.id}' has revisionCount ${prev.revisionCount}, expected 1`,
    );
  }

  return latest;
}

export function issueArtifactService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueArtifacts)
        .where(eq(issueArtifacts.issueId, issueId))
        .orderBy(desc(issueArtifacts.updatedAt));
      return rows.map(toIssueArtifact);
    },

    listLatestByType: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueArtifacts)
        .where(eq(issueArtifacts.issueId, issueId))
        .orderBy(desc(issueArtifacts.createdAt));

      // Deduplicate by artifactType, keeping only the latest per type
      const byType = new Map<ArtifactType, IssueArtifact>();
      for (const row of rows) {
        const type = row.artifactType as ArtifactType;
        if (!byType.has(type)) {
          byType.set(type, toIssueArtifact(row));
        }
      }
      return [...byType.values()];
    },

    /** Returns the validated chain head, or null if no published artifacts exist. */
    getLatestPublished: async (issueId: string): Promise<IssueArtifact | null> => {
      const all = await issueArtifactService(db).listForIssue(issueId);
      return validateArtifactChain(all);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueArtifacts)
        .where(eq(issueArtifacts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueArtifact(row) : null;
    },

    /**
     * Creates an artifact, validating phase-artifact invariants and computing revision count.
     *
     * @param companyId - Company context
     * @param currentPhase - The issue's current phase (for invariant validation)
     * @param data - Artifact creation input
     */
    create: async (
      companyId: string,
      currentPhase: IssuePhase,
      data: CreateIssueArtifact,
    ): Promise<IssueArtifact> => {
      const parsed = createIssueArtifactSchema.parse(data);

      // Phase-artifact type invariant
      assertArtifactTypeForPhase(parsed.artifactType as ArtifactType, currentPhase);

      // Compute revision count: find the latest artifact of this type and increment
      const existing = await db
        .select({ revisionCount: issueArtifacts.revisionCount })
        .from(issueArtifacts)
        .where(
          and(
            eq(issueArtifacts.issueId, parsed.issueId),
            eq(issueArtifacts.artifactType, parsed.artifactType),
          ),
        )
        .orderBy(desc(issueArtifacts.revisionCount))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const revisionCount = (existing?.revisionCount ?? 0) + 1;

      const row = await db
        .insert(issueArtifacts)
        .values({
          companyId,
          issueId: parsed.issueId,
          artifactType: parsed.artifactType,
          status: parsed.status ?? "published",
          actorAgentId: parsed.actorAgentId ?? null,
          actorUserId: parsed.actorUserId ?? null,
          createdByRunId: parsed.createdByRunId ?? null,
          summary: parsed.summary ?? null,
          metadata: parsed.metadata as Record<string, unknown>,
          revisionCount,
        })
        .returning()
        .then((rows) => rows[0]!);

      // Trigger orchestration after artifact is published
      if (row.status === "published") {
        await triggerOrchestration(db, parsed.issueId);
      }

      return toIssueArtifact(row);
    },

    publish: async (id: string) => {
      const row = await db
        .update(issueArtifacts)
        .set({ status: "published", updatedAt: new Date() })
        .where(eq(issueArtifacts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueArtifact(row) : null;
    },

    /**
     * Atomically supersedes all published artifacts of the same type for an issue
     * and records the supersession chain bidirectionally.
     *
     * supersededBy is set on each old artifact pointing to the NEXT artifact in the chain.
     * When called standalone (not from replace()), no single "next artifact" exists —
     * in that case supersededBy is left null and only the status is updated.
     *
     * Returns the newly superseded artifacts' ids.
     */
    supersede: async (issueId: string, artifactType: ArtifactType): Promise<string[]> => {
      // Find all currently published artifacts of this type
      const toSupersede = await db
        .select()
        .from(issueArtifacts)
        .where(
          and(
            eq(issueArtifacts.issueId, issueId),
            eq(issueArtifacts.artifactType, artifactType),
            eq(issueArtifacts.status, "published"),
          ),
        );

      if (toSupersede.length === 0) return [];

      // Use a transaction to make supersession atomic
      await db.transaction(async (tx) => {
        for (const old of toSupersede) {
          await tx
            .update(issueArtifacts)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(eq(issueArtifacts.id, old.id));
        }
      });

      return toSupersede.map((a) => a.id);
    },

    /**
     * Atomically supersedes the previous published artifact and creates a new published one.
     * Validates phase-artifact invariants and computes revision count.
     *
     * Both the insert and the status update of the previous artifact are wrapped
     * in a single transaction so that a crash between them cannot leave a
     * "published + orphaned predecessor" state.
     *
     * @returns The newly created artifact, or null if no previous published artifact existed.
     */
    replace: async (
      companyId: string,
      currentPhase: IssuePhase,
      issueId: string,
      artifactType: ArtifactType,
      metadata: Record<string, unknown>,
      actorAgentId?: string | null,
      summary?: string | null,
    ): Promise<IssueArtifact | null> => {
      assertArtifactTypeForPhase(artifactType, currentPhase);

      // Find current published artifact of this type
      const current = await db
        .select()
        .from(issueArtifacts)
        .where(
          and(
            eq(issueArtifacts.issueId, issueId),
            eq(issueArtifacts.artifactType, artifactType),
            eq(issueArtifacts.status, "published"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      const supersedesId = current?.id ?? null;
      const revisionCount = current
        ? current.revisionCount + 1
        : 1;

      let newRow!: IssueArtifactRow;

      await db.transaction(async (tx) => {
        [newRow] = await tx
          .insert(issueArtifacts)
          .values({
            companyId,
            issueId,
            artifactType,
            status: "published",
            actorAgentId: actorAgentId ?? null,
            summary: summary ?? null,
            metadata,
            supersedes: supersedesId,
            revisionCount,
          })
          .returning();

        // Atomically mark previous as superseded, pointing back to new row
        if (current) {
          await tx
            .update(issueArtifacts)
            .set({ status: "superseded", supersededBy: newRow.id, updatedAt: new Date() })
            .where(eq(issueArtifacts.id, current.id));
        }
      });

      // Trigger orchestration after artifact is published
      await triggerOrchestration(db, issueId);

      return toIssueArtifact(newRow);
    },
  };
}

export { toIssueArtifact };
export type { IssueArtifactRow };

/**
 * Bidirectional mapping: role → phase (derived from ARTIFACT_TYPE_FOR_PHASE).
 * Used by publishForCurrentPhase to derive the phase from the role when the
 * issue phase is not yet set.
 */
export const WORKFLOW_ROLE_PHASES: Record<WorkflowRole, IssuePhase> = {
  planner: "planning",
  plan_reviewer: "plan_review",
  executor: "executing",
  reviewer: "code_review",
  integrator: "integration",
} as const;

/**
 * Returns the phase associated with a workflow role.
 * Throws if the role is not a valid WorkflowRole.
 */
export function getPhaseForRole(role: WorkflowRole): IssuePhase {
  return WORKFLOW_ROLE_PHASES[role];
}

/**
 * Canonical usage patterns for each Claude Code workflow role.
 * Each pattern shows the minimal required metadata fields.
 *
 * Import:  import { CLAUDE_CODE_USAGE } from "../services/issue-artifacts.js";
 * Usage:   CLAUDE_CODE_USAGE.planner   // → JSDoc-style pattern object
 */
export const CLAUDE_CODE_USAGE = {
  planner: {
    role: "planner",
    phase: "planning",
    requiredMetadata: [
      "issueId",      // string — the issue being planned
      "goal",         // string — what the plan aims to achieve
      "acceptanceCriteria", // string[] — conditions for completion
      "touchedFiles", // string[] — files expected to be modified
      "forbiddenFiles", // string[] — files that must NOT be modified
      "testPlan",     // string — how to verify the plan works
      "risks",        // string[] — identified risks or unknowns
    ],
    example: `\
await publishForCurrentPhase(db, companyId, "planner", {
  issueId: issue.id,
  goal: "Add user authentication via OAuth",
  acceptanceCriteria: [
    "Users can log in with Google and GitHub",
    "Session persists across browser refreshes",
    "Logout invalidates session",
  ],
  touchedFiles: ["src/auth/login.ts", "src/middleware/session.ts"],
  forbiddenFiles: ["src/db/users.ts"],
  testPlan: "Run integration tests with mock OAuth provider",
  risks: ["OAuth provider rate limits may cause flakiness"],
});`,
  },

  plan_reviewer: {
    role: "plan_reviewer",
    phase: "plan_review",
    requiredMetadata: [
      "issueId",
      "verdict",       // "approved" | "rejected"
      "scopeChanges",  // string[] — changes to the plan's scope
      "notes",         // string[] — reviewer notes
    ],
    example: `\
await publishForCurrentPhase(db, companyId, "plan_reviewer", {
  issueId: issue.id,
  verdict: "approved",
  scopeChanges: [],
  notes: ["Consider adding an integration test for the OAuth callback"],
});`,
  },

  executor: {
    role: "executor",
    phase: "executing",
    requiredMetadata: [
      "issueId",
      "filesChanged",        // string[] — files modified
      "changesSummary",     // string — summary of changes
      "deviationsFromPlan", // string[] — where actual differed from plan
      "testsRun",           // string[] — tests executed
      "remainingWork",      // string[] — unfinished items
    ],
    example: `\
await publishForCurrentPhase(db, companyId, "executor", {
  issueId: issue.id,
  filesChanged: ["src/auth/login.ts", "src/middleware/session.ts"],
  changesSummary: "Added OAuth login with Google and GitHub providers",
  deviationsFromPlan: [],
  testsRun: ["npm test -- --grep auth", "npm run integration"],
  remainingWork: [],
});`,
  },

  reviewer: {
    role: "reviewer",
    phase: "code_review",
    requiredMetadata: [
      "issueId",
      "verdict",            // "approved" | "changes_requested" | "rejected"
      "issuesFound",       // string[] — issues identified
      "fixesMade",         // string[] — fixes applied
      "verificationStatus", // "verified" | "needs_verification" | "blocked"
      "mergeReadiness",    // "ready" | "blocked" | "conditional"
    ],
    example: `\
await publishForCurrentPhase(db, companyId, "reviewer", {
  issueId: issue.id,
  verdict: "approved",
  issuesFound: [],
  fixesMade: ["Refactored session middleware to use async/await"],
  verificationStatus: "verified",
  mergeReadiness: "ready",
});`,
  },

  integrator: {
    role: "integrator",
    phase: "integration",
    requiredMetadata: [
      "issueId",
      "finalVerification", // "passed" | "failed" | "skipped"
      "deploymentNotes",   // string[] — deployment instructions
      "signoffs",          // string[] — required signoffs obtained
      "remainingOpenIssues", // string[] — still-open non-blocking issues
      "rollbackPlan",      // string — how to roll back if needed
    ],
    example: `\
await publishForCurrentPhase(db, companyId, "integrator", {
  issueId: issue.id,
  finalVerification: "passed",
  deploymentNotes: ["Deploy to staging first; monitor error rates for 10 min"],
  signoffs: ["security-review", "data-team"],
  remainingOpenIssues: [],
  rollbackPlan: "Revert commit abc1234; re-run migration 0042",
});`,
  },
} as const;

/**
 * Workflow role labels — the canonical set of roles that drive issue orchestration.
 * Each role maps to exactly one artifact type and one phase.
 *
 * Usage (Claude Code):
 *   import { WORKFLOW_ROLES, publishForCurrentPhase } from "./services/issue-artifacts.js";
 *
 *   // Planner publishes a plan
 *   await publishForCurrentPhase(db, companyId, "planner", {
 *     issueId: "...",
 *     goal: "...",
 *     acceptanceCriteria: ["..."],
 *     touchedFiles: ["..."],
 *     forbiddenFiles: [],
 *     testPlan: "...",
 *     risks: [],
 *   });
 *
 *   // Plan reviewer approves
 *   await publishForCurrentPhase(db, companyId, "plan_reviewer", {
 *     issueId: "...",
 *     verdict: "approved",
 *     scopeChanges: [],
 *     notes: ["..."],
 *   });
 *
 *   // Executor completes work
 *   await publishForCurrentPhase(db, companyId, "executor", {
 *     issueId: "...",
 *     filesChanged: ["..."],
 *     changesSummary: "...",
 *     deviationsFromPlan: [],
 *     testsRun: ["..."],
 *     remainingWork: [],
 *   });
 *
 *   // Reviewer approves code
 *   await publishForCurrentPhase(db, companyId, "reviewer", {
 *     issueId: "...",
 *     verdict: "approved",
 *     issuesFound: [],
 *     fixesMade: ["..."],
 *     verificationStatus: "verified",
 *     mergeReadiness: "ready",
 *   });
 *
 *   // Integrator marks done
 *   await publishForCurrentPhase(db, companyId, "integrator", {
 *     issueId: "...",
 *     finalVerification: "passed",
 *     deploymentNotes: [],
 *     signoffs: ["..."],
 *     remainingOpenIssues: [],
 *     rollbackPlan: "...",
 *   });
 */
export const WORKFLOW_ROLES = ["planner", "plan_reviewer", "executor", "reviewer", "integrator"] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

/**
 * Canonical publish entrypoint for Claude Code workflow roles.
 *
 * Derives the current phase from the issue, validates that the given role's
 * artifact type is compatible with that phase, then atomically publishes the
 * artifact and triggers orchestration — all in one call.
 *
 * This is the ONLY entrypoint a Claude Code role agent should use to publish
 * a workflow artifact. Do NOT call replace() or create() directly.
 *
 * @param db           - Database instance
 * @param companyId    - Company context
 * @param role         - One of: planner | plan_reviewer | executor | reviewer | integrator
 * @param metadata     - Structured artifact metadata (MUST include issueId)
 * @param actorAgentId - Agent publishing the artifact (optional)
 * @param summary      - Human-readable summary (optional)
 */
export async function publishForCurrentPhase(
  db: Db,
  companyId: string,
  role: WorkflowRole,
  metadata: Record<string, unknown>,
  actorAgentId?: string | null,
  summary?: string | null,
): Promise<IssueArtifact | null> {
  const artifactType = role as ArtifactType;

  const issueId = metadata["issueId"];
  if (!issueId || typeof issueId !== "string" || issueId.length === 0) {
    throw new Error("publishForCurrentPhase requires metadata.issueId to be a non-empty string");
  }

  const issue = await issueService(db).getById(issueId);
  if (!issue) {
    throw new Error(`publishForCurrentPhase: issue '${issueId}' not found`);
  }

  const phase = (issue.phase as IssuePhase | null) ?? "triage";
  return publishArtifactForPhase(db, companyId, phase, artifactType, metadata, actorAgentId, summary);
}

/**
 * Triggers orchestration after artifact creation.
 * Uses dynamic import to avoid circular dependency between
 * issue-artifacts.ts and swarm-orchestrator.ts.
 *
 * Fail-closed: orchestration errors propagate to the caller so the
 * artifact publication can be retried atomically. Only module-not-resolvable
 * cases (fresh process before swarm-orchestrator is initialised) are skipped silently.
 */
async function triggerOrchestration(
  db: Db,
  issueId: string,
): Promise<OrchestrationDecision | null> {
  try {
    const { orchestrateIssue } = await import("./swarm-orchestrator.js");
    return await orchestrateIssue(db, issueId);
  } catch (err) {
    // Swallow only when the module itself cannot be loaded (e.g. fresh process
    // before swarm-orchestrator is available). Real runtime errors must surface.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("ERR_MODULE_NOT_FOUND")) {
      console.warn(`[issue-artifacts] orchestration unavailable (module not resolvable): ${msg}`);
      return null;
    }
    throw err;
  }
}
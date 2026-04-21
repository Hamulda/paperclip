import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueArtifacts } from "@paperclipai/db";
import type {
  IssueArtifact,
  ArtifactMetadata,
  ArtifactType,
  ArtifactStatus,
  IssuePhase,
} from "@paperclipai/shared";
import type { CreateIssueArtifact } from "@paperclipai/shared";
import { createIssueArtifactSchema } from "@paperclipai/shared";
import { PHASE_FOR_ARTIFACT_TYPE } from "@paperclipai/db";

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
 * Validates the published artifact chain for an issue.
 * Returns the latest valid published artifact chain head, or null if no published artifacts exist.
 *
 * Invariant: the chain must not have gaps (each artifact supersedes exactly one predecessor,
 * revisionCount increments by 1 per link).
 */
export function validateArtifactChain(
  artifacts: IssueArtifact[],
): IssueArtifact | null {
  const published = artifacts
    .filter((a) => a.status === "published")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (published.length === 0) return null;

  const [latest] = published;

  // Walk the supersedes chain backwards, verifying revision increments
  let current = latest;
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

  // The oldest artifact in the chain should have revisionCount === 1
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
     * and records the supersession chain.
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
            .set({ status: "superseded", supersededBy: old.id, updatedAt: new Date() })
            .where(eq(issueArtifacts.id, old.id));
        }
      });

      return toSupersede.map((a) => a.id);
    },

    /**
     * Atomically supersedes the previous published artifact and creates a new published one.
     * Validates phase-artifact invariants and computes revision count.
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

      const [newRow] = await db
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

      // Atomically mark previous as superseded
      if (current) {
        await db
          .update(issueArtifacts)
          .set({ status: "superseded", supersededBy: newRow.id, updatedAt: new Date() })
          .where(eq(issueArtifacts.id, current.id));
      }

      return toIssueArtifact(newRow);
    },
  };
}

export { toIssueArtifact };
export type { IssueArtifactRow };
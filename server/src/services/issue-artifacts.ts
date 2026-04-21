import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueArtifacts } from "@paperclipai/db";
import type {
  IssueArtifact,
  ArtifactMetadata,
  ArtifactType,
  ArtifactStatus,
} from "@paperclipai/shared";
import type { CreateIssueArtifact } from "@paperclipai/shared";
import { createIssueArtifactSchema } from "@paperclipai/shared";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueArtifacts)
        .where(eq(issueArtifacts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueArtifact(row) : null;
    },

    create: async (
      companyId: string,
      data: CreateIssueArtifact,
    ): Promise<IssueArtifact> => {
      const parsed = createIssueArtifactSchema.parse(data);
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

    supersede: async (issueId: string, artifactType: ArtifactType) => {
      await db
        .update(issueArtifacts)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(
          and(
            eq(issueArtifacts.issueId, issueId),
            eq(issueArtifacts.artifactType, artifactType),
            eq(issueArtifacts.status, "published"),
          ),
        );
    },
  };
}

export { toIssueArtifact };
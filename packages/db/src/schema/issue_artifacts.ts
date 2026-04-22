import { index, integer, jsonb, pgTable, text, timestamp, type AnyPgColumn, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const ARTIFACT_TYPES = ["planner", "plan_reviewer", "executor", "reviewer", "integrator"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = ["draft", "published", "superseded", "failed"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** Maps artifact type to the phase that must be active for it to advance the workflow */
export const PHASE_FOR_ARTIFACT_TYPE: Record<ArtifactType, string> = {
  planner: "planning",
  plan_reviewer: "plan_review",
  executor: "executing",
  reviewer: "code_review",
  integrator: "integration",
};

/** Reverse mapping: phase → artifact type required to advance from that phase */
export const ARTIFACT_TYPE_FOR_PHASE: Record<string, ArtifactType> = {
  planning: "planner",
  plan_review: "plan_reviewer",
  executing: "executor",
  code_review: "reviewer",
  integration: "integrator",
};

export const issueArtifacts = pgTable(
  "issue_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    artifactType: text("artifact_type").notNull(),
    status: text("status").notNull().default("published"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => issueArtifacts.id, { onDelete: "set null" }),
    supersedes: uuid("supersedes").references((): AnyPgColumn => issueArtifacts.id, { onDelete: "set null" }),
    revisionCount: integer("revision_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueTypeIdx: index("issue_artifacts_company_issue_type_idx").on(
      table.companyId,
      table.issueId,
      table.artifactType,
    ),
    companyStatusIdx: index("issue_artifacts_company_status_idx").on(table.companyId, table.status),
    issueUpdatedIdx: index("issue_artifacts_issue_updated_idx").on(table.issueId, table.updatedAt),
    supersededByIdx: index("issue_artifacts_superseded_by_idx").on(table.supersededBy),
    supersedesIdx: index("issue_artifacts_supersedes_idx").on(table.supersedes),
  }),
);
import { type AnyPgColumn, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const fileClaims = pgTable(
  "file_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    claimType: text("claim_type").notNull(),
    claimPath: text("claim_path").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("file_claims_company_project_idx").on(table.companyId, table.projectId),
    companyIssueIdx: index("file_claims_company_issue_idx").on(table.companyId, table.issueId),
    companyAgentIdx: index("file_claims_company_agent_idx").on(table.companyId, table.agentId),
    companyStatusExpiresIdx: index("file_claims_company_status_expires_idx").on(
      table.companyId,
      table.status,
      table.expiresAt,
    ),
    companyPathIdx: index("file_claims_path_idx").on(table.companyId, table.claimPath, table.status),
  }),
);

export type FileClaim = typeof fileClaims.$inferSelect;
export type NewFileClaim = typeof fileClaims.$inferInsert;

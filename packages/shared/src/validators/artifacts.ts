import { z } from "zod";

const plannerArtifactSchema = z.object({
  artifactType: z.literal("planner"),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  touchedFiles: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  testPlan: z.string(),
  risks: z.array(z.string()).default([]),
});

const planReviewerArtifactSchema = z.object({
  artifactType: z.literal("plan_reviewer"),
  verdict: z.enum(["approved", "rejected"]),
  scopeChanges: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

const executorArtifactSchema = z.object({
  artifactType: z.literal("executor"),
  filesChanged: z.array(z.string()).default([]),
  changesSummary: z.string(),
  deviationsFromPlan: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  remainingWork: z.array(z.string()).default([]),
});

const reviewerArtifactSchema = z.object({
  artifactType: z.literal("reviewer"),
  verdict: z.enum(["approved", "changes_requested", "rejected"]),
  issuesFound: z.array(z.string()).default([]),
  fixesMade: z.array(z.string()).default([]),
  verificationStatus: z.enum(["verified", "needs_verification", "blocked"]),
  mergeReadiness: z.enum(["ready", "blocked", "conditional"]),
});

export const artifactMetadataSchema = z.discriminatedUnion("artifactType", [
  plannerArtifactSchema,
  planReviewerArtifactSchema,
  executorArtifactSchema,
  reviewerArtifactSchema,
]);

export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;

export const createIssueArtifactSchema = z.object({
  issueId: z.string().uuid(),
  artifactType: z.enum(["planner", "plan_reviewer", "executor", "reviewer"]),
  status: z.enum(["draft", "published", "superseded", "failed"]).optional().default("published"),
  actorAgentId: z.string().uuid().optional().nullable(),
  actorUserId: z.string().optional().nullable(),
  createdByRunId: z.string().uuid().optional().nullable(),
  summary: z.string().trim().max(500).optional().nullable(),
  metadata: artifactMetadataSchema,
});

export type CreateIssueArtifact = z.infer<typeof createIssueArtifactSchema>;
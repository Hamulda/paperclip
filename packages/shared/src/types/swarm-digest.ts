// Shared DTO types for Swarm Digest / Swarm Cockpit
// Single source of truth for both server and UI - prevents contract drift

export interface SwarmDigestAgent {
  id: string;
  name: string;
  status: string;
  role: string | null;
}

export interface SwarmDigestClaimedPath {
  agentId: string;
  agentName: string;
  path: string;
  claimType: string;
  issueIdentifier: string | null;
}

export interface SwarmDigestClaimedPathsSummary {
  byAgent: {
    agentId: string;
    agentName: string;
    role: string | null;
    paths: string[];
    pathCount: number; // total unique paths claimed ( richer summary )
    issueIdentifier: string | null; // common issue being worked on
  }[];
}

export interface SwarmDigestRecommendedAvoidPaths {
  paths: string[];
  reasons: string[];
}

export interface SwarmDigestAutoClaimSuggestion {
  source: "issue_labels" | "issue_description" | "issue_title" | "diff"; // where suggestion came from
  path: string;
  claimType: string;
  reason: string; // human-readable reason for suggestion
  issueIdentifier?: string; // linked issue if source is issue_labels or issue_description
}

export type ProtectedPathsEnforcement = "hard_block" | "soft_warning";

export interface SwarmDigestProtectedPaths {
  defaultPatterns: string[]; // server-enforced defaults, never configurable
  configurablePatterns: string[]; // project-level overrides
  enforcement: ProtectedPathsEnforcement; // how violations are handled
}

export interface SwarmDigestRun {
  id: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  startedAt: string | null;
  swarmRole: string | null;
  phase?: string | null;
  verificationStatus?: string | null;
  mergeReadiness?: string | null;
  ownerAgentName?: string | null;
  blockers?: string[];
  /** Number of artifact revisions for this run (rework signal) */
  revisionCount?: number;
  /** Human-readable reason the run is blocked, if any */
  blockedReason?: string | null;
  /** The next role expected to act on this issue after current phase completes */
  expectedNextRole?: string | null;
}

export interface SwarmDigestWorkspace {
  id: string;
  name: string;
  branchName: string | null;
  worktreePath: string | null;
  status: string;
  sourceIssueId: string | null;
}

export interface SwarmDigestService {
  id: string;
  serviceName: string;
  status: string;
  url: string | null;
  ownerAgentId: string | null;
}

export interface SwarmDigestFileClaimConflict {
  claimPath: string;
  claimType: string;
  conflictingAgentId: string;
  conflictingRunId: string;
}

export interface SwarmDigestFileClaimStale {
  id: string;
  claimPath: string;
  claimType: string;
  agentId: string | null;
  runId: string | null;
  expiresAt: string;
  minutesUntilExpiry: number;
}

export interface SwarmDigestServiceDegraded {
  id: string;
  serviceName: string;
  status: string;
  healthStatus: string;
  url: string | null;
  ownerAgentId: string | null;
}

export interface SwarmDigestRunStuck {
  id: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  minutesWaiting: number;
}

export type VerificationStatus = "ready_for_review" | "needs_verification" | "verified" | "blocked";

export interface SwarmDigestHandoff {
  id: string;
  agentId: string;
  agentName: string;
  swarmRole: string | null;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
  avoidPaths: string[];
  emittedAt: string;
  verificationStatus: VerificationStatus | null;
  mergeReadiness?: string | null;
}

export interface SwarmDigest {
  companyId: string;
  projectId: string | null;
  generatedAt: string;
  activeAgents: SwarmDigestAgent[];
  activeRuns: SwarmDigestRun[];
  workspaces: SwarmDigestWorkspace[];
  services: SwarmDigestService[];
  fileClaimConflicts: SwarmDigestFileClaimConflict[];
  fileClaimStale: SwarmDigestFileClaimStale[];
  servicesDegraded: SwarmDigestServiceDegraded[];
  runsStuck: SwarmDigestRunStuck[];
  recentHandoffs: SwarmDigestHandoff[];
  latestHandoff: SwarmDigestHandoff | null;
  claimedPathsSummary: SwarmDigestClaimedPathsSummary;
  recommendedAvoidPaths: SwarmDigestRecommendedAvoidPaths;
  autoClaimSuggestions: SwarmDigestAutoClaimSuggestion[];
  protectedPaths: SwarmDigestProtectedPaths;
}

export interface SwarmDigestReviewQueue {
  readyForReview: SwarmDigestHandoff[];
  needsVerification: SwarmDigestHandoff[];
  blocked: SwarmDigestHandoff[];
}

export interface SwarmDigestCollaborationHint {
  type: "role_coordination" | "review_needed" | "blocked" | "conflict_risk";
  message: string;
  urgency: "high" | "medium" | "low";
  relatedIssue?: string | null;
}

export interface SwarmCockpitDigest extends SwarmDigest {
  hotSlotUsage: {
    current: number;
    max: number;
  };
  queuedHotRunsCount: number;
  reviewQueue: SwarmDigestReviewQueue;
  collaborationHints: SwarmDigestCollaborationHint[];
  recentArtifacts: SwarmDigestArtifact[];
  /** Per-issue workflow summary: owner, phase, rework signal, blocked reason, expected next role, artifact chain */
  issueWorkflowSummary: SwarmDigestIssueSummary[];
}

// ---------------------------------------------------------------------------
// Artifact summary for digest
// ---------------------------------------------------------------------------

export interface SwarmDigestArtifact {
  id: string;
  artifactType: string;
  status: string;
  summary: string | null;
  actorAgentId: string | null;
  actorAgentName: string | null;
  createdAt: string;
  goal?: string | null;
  verdict?: string | null;
  filesChanged?: string[] | null;
  verificationStatus?: string | null;
  mergeReadiness?: string | null;
  /** Number of revisions for this artifact type (1 = first, 2+ = rework) */
  revisionCount?: number;
  /** Chain depth: total published artifacts for this issue (longer = more rework cycles) */
  artifactChainDepth?: number;
  /** Issue this artifact belongs to (for chain depth computation) */
  issueId?: string;
}

// ---------------------------------------------------------------------------
// Per-issue workflow summary for digest
// ---------------------------------------------------------------------------

export interface SwarmDigestIssueSummary {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  phase: string | null;
  assigneeAgentName: string | null;
  /** Whether the issue is in a rework cycle (revisionCount >= 2 for current phase) */
  isRework: boolean;
  /** Number of times this phase has been reworked */
  reworkCount: number;
  /** Why the issue is blocked, if phase is blocked */
  blockedReason: string | null;
  /** Next role expected after current phase completes */
  expectedNextRole: string | null;
  /** Next phase expected after current phase completes */
  expectedNextPhase: string | null;
  /** Artifact types already produced for this issue (artifact chain summary) */
  artifactChain: string[];
}

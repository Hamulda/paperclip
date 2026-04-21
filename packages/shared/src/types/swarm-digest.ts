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

export interface SwarmDigestProtectedPaths {
  paths: string[]; // hard-blocked paths that should never be claimed
  enforcedBy: "server" | "config"; // who enforces these rules
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

export interface SwarmCockpitDigest extends SwarmDigest {
  hotSlotUsage: {
    current: number;
    max: number;
  };
  queuedHotRunsCount: number;
}

import { api } from "./client";

export interface SwarmDigestAgent {
  id: string;
  name: string;
  status: string;
}

export interface SwarmDigestRun {
  id: string;
  agentId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  status: string;
  startedAt: string | null;
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
  startedAt: string | null;
  minutesWaiting: number;
}

export interface SwarmDigestHandoff {
  id: string;
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
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
}

export interface SwarmCockpitDigest extends SwarmDigest {
  hotSlotUsage: {
    current: number;
    max: number;
  };
  queuedHotRunsCount: number;
}

export const swarmDigestApi = {
  getCockpitDigest: (companyId: string, projectId?: string) => {
    const searchParams = new URLSearchParams();
    if (projectId) searchParams.set("projectId", projectId);
    const qs = searchParams.toString();
    return api.get<SwarmCockpitDigest>(
      `/companies/${companyId}/swarm-digest${qs ? `?${qs}` : ""}`,
    );
  },
};

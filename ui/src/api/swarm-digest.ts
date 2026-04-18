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

export interface SwarmDigest {
  companyId: string;
  projectId: string | null;
  generatedAt: string;
  activeAgents: SwarmDigestAgent[];
  activeRuns: SwarmDigestRun[];
  workspaces: SwarmDigestWorkspace[];
  services: SwarmDigestService[];
  fileClaimConflicts: SwarmDigestFileClaimConflict[];
}

export interface SwarmCockpitDigest extends SwarmDigest {
  hotSlotUsage: {
    current: number;
    maxPerAgent: number;
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

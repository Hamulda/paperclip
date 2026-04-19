import { api } from "./client";
import type {
  SwarmDigest,
  SwarmDigestAgent,
  SwarmDigestRun,
  SwarmDigestWorkspace,
  SwarmDigestService,
  SwarmDigestFileClaimConflict,
  SwarmDigestFileClaimStale,
  SwarmDigestServiceDegraded,
  SwarmDigestRunStuck,
  SwarmDigestHandoff,
  SwarmCockpitDigest,
} from "@paperclipai/shared";

// Re-export for convenience in case components import from here
export type {
  SwarmDigest,
  SwarmDigestAgent,
  SwarmDigestRun,
  SwarmDigestWorkspace,
  SwarmDigestService,
  SwarmDigestFileClaimConflict,
  SwarmDigestFileClaimStale,
  SwarmDigestServiceDegraded,
  SwarmDigestRunStuck,
  SwarmDigestHandoff,
  SwarmCockpitDigest,
};

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

import type { Db } from "@paperclipai/db";
import type { FileClaim } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { acquireClaims, releaseClaims } from "./file-claims.js";
import { buildSwarmDigest, formatSwarmDigestForPrompt } from "./swarm-digest.js";
import type { SwarmDigest } from "@paperclipai/shared";
import type { ClaimInput } from "./file-claims.js";

export interface FileClaimConflictWarning {
  claimPath: string;
  claimType: string;
  conflictingAgentId: string | null;
  conflictingRunId: string | null;
}

export interface EnrichRunContextWithSwarmStateResult {
  /** IDs of claims acquired for this run — pass to releaseClaims() on cleanup */
  claimIds: string[];
  /** File claim conflicts detected at acquisition time */
  conflictWarnings: FileClaimConflictWarning[];
  /** Swarm digest describing current coding swarm state */
  swarmDigest: SwarmDigest;
  /** Human-readable digest formatted for injection into a prompt */
  swarmDigestFormatted: string;
}

/**
 * Release function — call from the run's finally block to release acquired claims.
 * Exposed separately so the caller controls when it fires (no automatic finally hook).
 */
export function createReleaseFileClaimsFn(db: Db, params: {
  companyId: string;
  agentId: string;
  runId: string;
}) {
  return () =>
    releaseClaims(db, {
      companyId: params.companyId,
      agentId: params.agentId,
      runId: params.runId,
    });
}

export interface EnrichRunContextWithSwarmStateOptions {
  db: Db;
  fileClaimsInput: unknown;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  agentId: string;
  runId: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

/**
 * Pre-adapter context enrichment step that:
 * 1. Acquires file/directory claims for the run (so the digest reflects current claim state)
 * 2. Builds the swarm digest for collaborator awareness
 *
 * The two operations are separated by an ordering constraint (claims first, digest second)
 * but are kept in one function because they share the same inputs and are always invoked
 * together before the adapter executes.
 */
export async function enrichRunContextWithSwarmState({
  db,
  fileClaimsInput,
  companyId,
  projectId,
  issueId,
  agentId,
  runId,
  onLog,
}: EnrichRunContextWithSwarmStateOptions): Promise<EnrichRunContextWithSwarmStateResult> {
  let claimIds: string[] = [];
  let conflictWarnings: FileClaimConflictWarning[] = [];

  const rawFileClaims = parseObject(fileClaimsInput);
  if (Array.isArray(rawFileClaims) && rawFileClaims.length > 0) {
    const claimsToAcquire = rawFileClaims
      .filter((c): c is { claimType: string; claimPath: string } =>
        typeof c === "object" &&
        c !== null &&
        typeof c.claimType === "string" &&
        ["file", "directory", "glob"].includes(c.claimType) &&
        typeof c.claimPath === "string" &&
        c.claimPath.length > 0,
      )
      .map((c) => ({ claimType: c.claimType as ClaimInput["claimType"], claimPath: c.claimPath }));

    if (claimsToAcquire.length > 0) {
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const { acquired, conflicts } = await acquireClaims(db, {
        companyId,
        projectId,
        issueId: issueId ?? null,
        agentId,
        runId,
        claims: claimsToAcquire,
        expiresAt,
      });

      claimIds = acquired.map((c: FileClaim) => c.id);

      if (conflicts.length > 0) {
        conflictWarnings = conflicts.map((c) => ({
          claimPath: c.claimPath,
          claimType: c.claimType,
          conflictingAgentId: c.agentId,
          conflictingRunId: c.runId,
        }));
        await onLog(
          "stderr",
          `[paperclip] File claim conflicts detected: ${conflictWarnings.length} overlapping claims from other agents\n`,
        );
      }
    }
  }

  const swarmDigest = await buildSwarmDigest(db, {
    companyId,
    projectId,
    currentRunId: runId,
    currentAgentId: agentId,
  });
  const swarmDigestFormatted = formatSwarmDigestForPrompt(swarmDigest);

  return {
    claimIds,
    conflictWarnings,
    swarmDigest,
    swarmDigestFormatted,
  };
}

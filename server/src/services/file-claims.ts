import type { Db } from "@paperclipai/db";
import { and, eq, inArray, ne, sql, lte, gte } from "drizzle-orm";
import { fileClaims, type FileClaim } from "@paperclipai/db";

export type ClaimType = "file" | "directory" | "glob";

export interface ClaimInput {
  claimType: ClaimType;
  claimPath: string;
}

export interface ClaimWithConflict extends FileClaim {
  conflictingClaims: FileClaim[];
}

export interface AcquireClaimsInput {
  companyId: string;
  projectId?: string | null;
  issueId?: string | null;
  agentId: string;
  runId: string;
  claims: ClaimInput[];
  expiresAt: Date;
}

export interface RefreshClaimsInput {
  companyId: string;
  agentId: string;
  runId: string;
  claimIds: string[];
  expiresAt: Date;
}

export interface ReleaseClaimsInput {
  companyId: string;
  agentId: string;
  runId: string;
  claimIds?: string[];
}

export interface ListConflictsInput {
  companyId: string;
  projectId?: string | null;
  paths: string[];
  excludeAgentId?: string | null;
  excludeRunId?: string | null;
}

function matchesGlob(pattern: string, path: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
  );
  return regex.test(path);
}

function pathsOverlap(claimPath: string, claimType: ClaimType, otherPath: string, otherType: ClaimType): boolean {
  if (claimPath === otherPath) return true;

  if (claimType === "glob" && matchesGlob(claimPath, otherPath)) return true;
  if (otherType === "glob" && matchesGlob(otherPath, claimPath)) return true;

  if (claimType === "directory" && otherPath.startsWith(claimPath + "/")) return true;
  if (otherType === "directory" && claimPath.startsWith(otherPath + "/")) return true;

  return false;
}

export async function acquireClaims(
  db: Db,
  input: AcquireClaimsInput,
): Promise<{ acquired: FileClaim[]; conflicts: ClaimWithConflict[] }> {
  const { companyId, projectId, issueId, agentId, runId, claims, expiresAt } = input;

  const now = new Date();
  const conflicts: ClaimWithConflict[] = [];

  // Single query: fetch all active, non-expired claims for this company
  const existingClaims = await db
    .select()
    .from(fileClaims)
    .where(
      and(
        eq(fileClaims.companyId, companyId),
        eq(fileClaims.status, "active"),
        gte(fileClaims.expiresAt, now),
      ),
    );

  // Separate claims into conflicting and non-conflicting upfront
  const conflictClaimInputs: ClaimInput[] = [];
  const nonConflictClaimInputs: ClaimInput[] = [];

  for (const claim of claims) {
    const overlapping = existingClaims.filter(
      (c) =>
        c.agentId !== agentId &&
        pathsOverlap(claim.claimPath, claim.claimType, c.claimPath, c.claimType as ClaimType),
    );

    if (overlapping.length > 0) {
      conflictClaimInputs.push(claim);
    } else {
      nonConflictClaimInputs.push(claim);
    }
  }

  // Batch insert all non-conflicting claims in a single query
  let acquired: FileClaim[] = [];
  if (nonConflictClaimInputs.length > 0) {
    const values = nonConflictClaimInputs.map((claim) => ({
      companyId,
      projectId: projectId ?? null,
      issueId: issueId ?? null,
      agentId,
      runId,
      claimType: claim.claimType,
      claimPath: claim.claimPath,
      status: "active" as const,
      expiresAt,
    }));

    acquired = await db
      .insert(fileClaims)
      .values(values)
      .returning();
  }

  // Insert conflicting claims individually and track their overlaps
  for (const claim of conflictClaimInputs) {
    const overlapping = existingClaims.filter(
      (c) =>
        c.agentId !== agentId &&
        pathsOverlap(claim.claimPath, claim.claimType, c.claimPath, c.claimType as ClaimType),
    );

    const [newClaim] = await db
      .insert(fileClaims)
      .values({
        companyId,
        projectId: projectId ?? null,
        issueId: issueId ?? null,
        agentId,
        runId,
        claimType: claim.claimType,
        claimPath: claim.claimPath,
        status: "active",
        expiresAt,
      })
      .returning();

    if (newClaim) {
      conflicts.push({ ...newClaim, conflictingClaims: overlapping });
    }
  }

  return { acquired, conflicts };
}

export async function refreshClaims(
  db: Db,
  input: RefreshClaimsInput,
): Promise<FileClaim[]> {
  const { companyId, agentId, runId, claimIds, expiresAt } = input;

  if (claimIds.length === 0) return [];

  return db
    .update(fileClaims)
    .set({
      expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fileClaims.companyId, companyId),
        eq(fileClaims.agentId, agentId),
        eq(fileClaims.runId, runId),
        inArray(fileClaims.id, claimIds),
        eq(fileClaims.status, "active"),
      ),
    )
    .returning();
}

export async function releaseClaims(
  db: Db,
  input: ReleaseClaimsInput,
): Promise<FileClaim[]> {
  const { companyId, agentId, runId, claimIds } = input;

  if (claimIds && claimIds.length > 0) {
    return db
      .update(fileClaims)
      .set({
        status: "released",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(fileClaims.companyId, companyId),
          eq(fileClaims.agentId, agentId),
          eq(fileClaims.runId, runId),
          inArray(fileClaims.id, claimIds),
          eq(fileClaims.status, "active"),
        ),
      )
      .returning();
  }

  return db
    .update(fileClaims)
    .set({
      status: "released",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fileClaims.companyId, companyId),
        eq(fileClaims.agentId, agentId),
        eq(fileClaims.runId, runId),
        eq(fileClaims.status, "active"),
      ),
    )
    .returning();
}

export async function listConflicts(
  db: Db,
  input: ListConflictsInput,
): Promise<ClaimWithConflict[]> {
  const { companyId, projectId, paths, excludeAgentId, excludeRunId } = input;
  const now = new Date();

  const conditions = [
    eq(fileClaims.companyId, companyId),
    eq(fileClaims.status, "active"),
    gte(fileClaims.expiresAt, now),
  ];

  if (projectId) {
    conditions.push(eq(fileClaims.projectId, projectId));
  }

  if (excludeAgentId) {
    conditions.push(ne(fileClaims.agentId, excludeAgentId));
  }

  if (excludeRunId) {
    conditions.push(ne(fileClaims.runId, excludeRunId));
  }

  const activeClaims = await db
    .select()
    .from(fileClaims)
    .where(and(...conditions));

  // Use Map to avoid duplicate entries for the same claim
  const conflictsMap = new Map<string, ClaimWithConflict>();

  for (const path of paths) {
    // Find all active claims that overlap with this path
    const claimsOnPath = activeClaims.filter(
      (c) => pathsOverlap(c.claimPath, c.claimType as ClaimType, path, "file"),
    );

    // For each claim, find OTHER claims on the same path from different runs
    for (const claim of claimsOnPath) {
      const conflicting = claimsOnPath.filter(
        (c) =>
          c.id !== claim.id &&
          c.runId !== claim.runId &&
          pathsOverlap(claim.claimPath, claim.claimType as ClaimType, c.claimPath, c.claimType as ClaimType),
      );

      if (conflicting.length > 0) {
        if (!conflictsMap.has(claim.id)) {
          conflictsMap.set(claim.id, { ...claim, conflictingClaims: conflicting });
        }
      }
    }
  }

  return Array.from(conflictsMap.values());
}

export async function expireOldClaims(db: Db, companyId: string): Promise<number> {
  const result = await db
    .update(fileClaims)
    .set({
      status: "expired",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fileClaims.companyId, companyId),
        eq(fileClaims.status, "active"),
        lte(fileClaims.expiresAt, new Date()),
      ),
    );

  return (result as any).rowCount ?? 0;
}

export async function getActiveClaimsForRun(
  db: Db,
  companyId: string,
  runId: string,
  projectId?: string | null,
): Promise<FileClaim[]> {
  const conditions = [
    eq(fileClaims.companyId, companyId),
    eq(fileClaims.runId, runId),
    eq(fileClaims.status, "active"),
  ];

  if (projectId) {
    conditions.push(eq(fileClaims.projectId, projectId));
  }

  return db
    .select()
    .from(fileClaims)
    .where(and(...conditions));
}

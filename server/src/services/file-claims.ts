import type { Db } from "@paperclipai/db";
import { and, eq, inArray, ne, sql, lte, gte } from "drizzle-orm";
import { fileClaims, type FileClaim } from "@paperclipai/db";

export type ClaimType = "file" | "directory" | "glob";

export interface ClaimInput {
  claimType: ClaimType;
  claimPath: string;
}

/**
 * Normalize claim path for consistent comparison.
 * - trim whitespace
 * - normalize separators (backslash -> forward slash)
 * - remove redundant "./" prefixes
 * - collapse multiple slashes
 * - remove trailing slash (except for root)
 */
export function normalizePath(path: string): string {
  if (!path) return "";
  let normalized = path.trim().replace(/\\/g, "/");
  // Remove leading ./
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, "/");
  // Remove trailing slash unless it's root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathsOverlap(claimPath: string, claimType: ClaimType, otherPath: string, otherType: ClaimType): boolean {
  const normClaim = normalizePath(claimPath);
  const normOther = normalizePath(otherPath);

  if (normClaim === normOther) return true;

  if (claimType === "glob" && matchesGlob(normClaim, normOther)) return true;
  if (otherType === "glob" && matchesGlob(normOther, normClaim)) return true;

  if (claimType === "directory" && otherType === "glob" && normOther.startsWith(normClaim + "/")) return true;
  if (otherType === "directory" && claimType === "glob" && normClaim.startsWith(normOther + "/")) return true;

  if (claimType === "directory" && normOther.startsWith(normClaim + "/")) return true;
  if (claimType === "file" && otherType === "directory" && normClaim.startsWith(normOther + "/")) return true;

  if (otherType === "directory" && normClaim.startsWith(normOther + "/")) return true;
  if (otherType === "file" && claimType === "directory" && normOther.startsWith(normClaim + "/")) return true;

  return false;
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
  protectedPaths?: string[]; // optional override of protected path patterns
}

export interface AcquireClaimsResult {
  acquired: FileClaim[];
  conflicts: ClaimWithConflict[];
  blocked: ClaimInput[]; // claims blocked due to protected path rules
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

/**
 * Protected paths registry — hard-block rules for critical directories/files
 * that should never be claimed. These are project-agnostic defaults.
 */
export interface ProtectedPathsConfig {
  patterns: string[]; // glob patterns that are protected
}

export const DEFAULT_PROTECTED_PATTERNS = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".git/**",
  ".github/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".nuxt/**",
  ".output/**",
  ".cache/**",
  ".parcel-cache/**",
  "__pycache__/**",
  "*.pyc",
  ".venv/**",
  "venv/**",
  "*.egg-info/**",
  ".turbo/**",
  ".vercel/**",
  ".netlify/**",
  ".env",
  ".env.*",
  "!.env.example",
  "tsconfig*.json",
  "jsconfig*.json",
  "jest.config.*",
  "vitest.config.*",
  "*.test.ts",
  "*.test.tsx",
  "*.spec.ts",
  "*.spec.tsx",
  "*.stories.tsx",
  "*.md",
];

/**
 * Check if a path matches any protected pattern.
 * Handles both exact glob matches and file-name-based matches (e.g., "package.json" matches "src/package.json").
 */
export function isProtectedPath(path: string, protectedPatterns: string[] = DEFAULT_PROTECTED_PATTERNS): boolean {
  const normalized = normalizePath(path);
  for (const pattern of protectedPatterns) {
    // Direct glob match
    if (matchesGlob(pattern, normalized)) {
      return true;
    }
    // Directory pattern with /**
    if (matchesGlob(pattern + "/**", normalized)) {
      return true;
    }
    // For non-glob patterns like "package.json", check if path ends with /pattern
    if (!pattern.includes("*")) {
      if (normalized === pattern || normalized.endsWith("/" + pattern)) {
        return true;
      }
    }
    // For patterns like "*.test.ts" that should match any directory, check if path ends with the pattern
    // This handles cases like "src/foo.test.ts" matching pattern "*.test.ts"
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // "*.test.ts" -> ".test.ts"
      if (normalized.endsWith(suffix)) {
        return true;
      }
    }
    // For patterns with ** like "src/**/*.ts", check if path matches
    // Split by ** and check prefix/suffix match, allowing ** to match zero or more path segments
    if (pattern.includes("**")) {
      const parts = pattern.split("**");
      if (parts.length === 2) {
        let [prefix, suffix] = parts;
        // Strip leading / from suffix since we want to match the end of the path
        if (suffix.startsWith("/")) {
          suffix = suffix.slice(1);
        }
        // Path must start with prefix and end with suffix (glob match for suffix)
        if (normalized.startsWith(prefix) && matchesGlob(suffix, normalized.slice(prefix.length))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Filter out protected paths from a list of claim inputs.
 * Returns { allowed: ClaimInput[], blocked: ClaimInput[] }
 */
export function filterProtectedPaths(
  claims: ClaimInput[],
  protectedPatterns: string[] = DEFAULT_PROTECTED_PATTERNS,
): { allowed: ClaimInput[]; blocked: ClaimInput[] } {
  const allowed: ClaimInput[] = [];
  const blocked: ClaimInput[] = [];

  for (const claim of claims) {
    if (isProtectedPath(claim.claimPath, protectedPatterns)) {
      blocked.push(claim);
    } else {
      allowed.push(claim);
    }
  }

  return { allowed, blocked };
}

/**
 * Extract claim path suggestions from a git diff.
 * Supports:
 * - Added/modified file paths (lines starting with + but not +++)
 * - Renamed file paths
 */
export function extractClaimPathsFromDiff(diff: string): ClaimInput[] {
  const claims: ClaimInput[] = [];
  const seen = new Set<string>();

  function addClaim(path: string) {
    const normalized = normalizePath(path);
    const key = `file:${normalized}`;
    if (!seen.has(key) && normalized) {
      seen.add(key);
      claims.push({ claimPath: normalized, claimType: "file" });
    }
  }

  const lines = diff.split("\n");
  for (const line of lines) {
    // Match: +new_file.ts (added file, not diff header)
    // or: rename from old.ts / rename to new.ts
    // or: diff --git a/path/to/file.ts b/path/to/file.ts (extract both paths)
    const diffHeaderMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diffHeaderMatch) {
      addClaim(diffHeaderMatch[2]);
      continue;
    }

    // Added file: +++ b/newfile.ts
    const addedMatch = line.match(/^\+{3}\s+b\/(.+)$/);
    if (addedMatch && !line.startsWith("+++ b/")) {
      // skip binary files and mode changes
      addClaim(addedMatch[1]);
      continue;
    }

    // Renamed files
    const renameMatch = line.match(/^rename (?:from|to)\s+(.+)$/);
    if (renameMatch) {
      addClaim(renameMatch[1]);
      continue;
    }
  }

  return claims;
}

function matchesGlob(pattern: string, path: string): boolean {
  // CRITICAL: protect ** output from * replacement.
  // Replace in strict order: ** placeholder -> * -> dots -> restore **
  const placeholder = "\x00DOUBLESTAR\x00";
  const regexPattern = pattern
    .replace(/\*\*/g, placeholder)
    .replace(/\*/g, "[^/]*")
    .replace(/\./g, "\\.")
    .replace(new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), ".*");
  const regex = new RegExp("^" + regexPattern + "$");
  return regex.test(path);
}

export async function acquireClaims(
  db: Db,
  input: AcquireClaimsInput,
): Promise<AcquireClaimsResult> {
  const { companyId, projectId, issueId, agentId, runId, claims, expiresAt, protectedPaths } = input;

  const now = new Date();
  const conflicts: ClaimWithConflict[] = [];
  const blocked: ClaimInput[] = [];

  // Filter out protected paths first
  const { allowed: unprotectedClaims, blocked: protectedBlocked } = filterProtectedPaths(
    claims,
    protectedPaths,
  );
  blocked.push(...protectedBlocked);

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

  for (const claim of unprotectedClaims) {
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

  return { acquired, conflicts, blocked };
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
  const conditions: ReturnType<typeof eq>[] = [
    eq(fileClaims.companyId, companyId),
    eq(fileClaims.runId, runId),
    eq(fileClaims.status, "active"),
    gte(fileClaims.expiresAt, new Date()),
  ];

  if (projectId) {
    conditions.push(eq(fileClaims.projectId, projectId));
  }

  return db
    .select()
    .from(fileClaims)
    .where(and(...conditions));
}

/**
 * Extract claim path suggestions from issue labels and description.
 * Supports:
 * - Label pattern: "claims:src/foo/**" or "claim:src/bar/file.ts"
 * - Description pattern: lines starting with "- claim:" or "* claim:"
 */
export function extractClaimPathsFromIssue(input: {
  labels?: string[];
  description?: string | null;
}): ClaimInput[] {
  const claims: ClaimInput[] = [];
  const seen = new Set<string>();

  function addClaim(path: string, type: ClaimType) {
    const normalized = normalizePath(path);
    const key = `${type}:${normalized}`;
    if (!seen.has(key) && normalized) {
      seen.add(key);
      claims.push({ claimPath: normalized, claimType: type });
    }
  }

  function parsePathFromLabel(label: string): { path: string; type: ClaimType } | null {
    // Handle "claims:" or "claim:" prefix
    const match = label.match(/^(?:claims?|claim):\s*(.+)$/i);
    if (!match) return null;
    const rawPath = match[1].trim();
    if (!rawPath) return null;

    // Determine claim type BEFORE normalization (since normalization removes trailing slashes)
    let type: ClaimType = "file";
    if (rawPath.includes("**") || rawPath.includes("*")) {
      type = "glob";
    } else if (rawPath.endsWith("/")) {
      type = "directory";
    }

    const path = normalizePath(rawPath);
    return { path, type };
  }

  function parseClaimFromLine(line: string): string | null {
    // Lines like "- claim:path/to/file.ts", "* claim:src/**", or "- * claim:src/utils/"
    // Handles multiple optional bullet markers (e.g., "- *" or "*") before claim:
    const match = line.match(/^[\s]*[-*]+(?:\s+[-*]+)*\s*(?:claim|claims?):\s*(.+)$/i);
    return match ? match[1].trim() : null;
  }

  // Parse labels
  if (input.labels) {
    for (const label of input.labels) {
      const parsed = parsePathFromLabel(label);
      if (parsed) {
        addClaim(parsed.path, parsed.type);
      }
    }
  }

  // Parse description
  if (input.description) {
    const lines = input.description.split("\n");
    for (const line of lines) {
      const rawPath = parseClaimFromLine(line);
      if (rawPath) {
        // Determine type BEFORE normalization (since normalization removes trailing slashes)
        let type: ClaimType = "file";
        if (rawPath.includes("**") || rawPath.includes("*")) {
          type = "glob";
        } else if (rawPath.endsWith("/")) {
          type = "directory";
        }
        const path = normalizePath(rawPath);
        addClaim(path, type);
      }
    }
  }

  return claims;
}

import { describe, expect, it, vi } from "vitest";
import { enrichRunContextWithSwarmState } from "../services/enrich-run-context.js";

describe("enrichRunContextWithSwarmState", () => {
  function makeQueryChain(result: unknown): any {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    set: () => chain,
    returning: () => chain,
    then: (resolve: any) => resolve(result),
  };
  return chain;
}

function makeDbFn() {
  return vi.fn(() => makeQueryChain([]));
}

const mockDb = {
  select: makeDbFn(),
  from: makeDbFn(),
  insert: makeDbFn(),
  update: makeDbFn(),
  delete: makeDbFn(),
  transaction: vi.fn(),
} as unknown as Record<string, unknown>;

  const mockOnLog = vi.fn().mockResolvedValue(undefined);

  it("returns empty claimIds and conflictWarnings when fileClaimsInput is null", async () => {
    const result = await enrichRunContextWithSwarmState({
      db: mockDb as any,
      fileClaimsInput: null,
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      onLog: mockOnLog,
    });

    expect(result.claimIds).toEqual([]);
    expect(result.conflictWarnings).toEqual([]);
    expect(result.swarmDigest).toBeDefined();
    expect(typeof result.swarmDigestFormatted).toBe("string");
  });

  it("returns empty claimIds and conflictWarnings when fileClaimsInput is non-array", async () => {
    const result = await enrichRunContextWithSwarmState({
      db: mockDb as any,
      fileClaimsInput: { not: "an array" },
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      onLog: mockOnLog,
    });

    expect(result.claimIds).toEqual([]);
    expect(result.conflictWarnings).toEqual([]);
  });

  it("returns empty claimIds and conflictWarnings when fileClaimsInput is empty array", async () => {
    const result = await enrichRunContextWithSwarmState({
      db: mockDb as any,
      fileClaimsInput: [],
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      onLog: mockOnLog,
    });

    expect(result.claimIds).toEqual([]);
    expect(result.conflictWarnings).toEqual([]);
  });

  it("filters invalid claim entries", async () => {
    const result = await enrichRunContextWithSwarmState({
      db: mockDb as any,
      fileClaimsInput: [
        { claimType: "invalid", claimPath: "/some/path" },
        { claimType: "file", claimPath: "" },
        null,
      ],
      companyId: "company-1",
      projectId: "project-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      onLog: mockOnLog,
    });

    expect(result.claimIds).toEqual([]);
    expect(result.conflictWarnings).toEqual([]);
  });

  it("returns swarmDigest and swarmDigestFormatted as non-empty strings", async () => {
    const result = await enrichRunContextWithSwarmState({
      db: mockDb as any,
      fileClaimsInput: null,
      companyId: "company-1",
      projectId: null,
      issueId: null,
      agentId: "agent-1",
      runId: "run-1",
      onLog: mockOnLog,
    });

    expect(result.swarmDigest).toBeDefined();
    expect(typeof result.swarmDigestFormatted).toBe("string");
    expect(result.swarmDigestFormatted.length).toBeGreaterThan(0);
  });
});

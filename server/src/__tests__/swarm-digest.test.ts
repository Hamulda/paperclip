import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildSwarmDigest,
  formatSwarmDigestForPrompt,
  type SwarmDigest,
  buildHandoffComment,
  parseHandoffComment,
  isHandoffComment,
  HANDOFF_COMMENT_PREFIX,
  type StructuredHandoff,
} from "../services/swarm-digest.js";

// Mock the db module
vi.mock("@paperclipai/db", async () => {
  const actual = await vi.importActual("@paperclipai/db");
  return {
    ...actual,
    agents: { id: "", name: "", status: "", companyId: "" },
    heartbeatRuns: {},
    executionWorkspaces: {},
    workspaceRuntimeServices: {},
    issues: {},
  };
});

describe("buildSwarmDigest", () => {
  it("returns empty digest when companyId is empty", async () => {
    const mockDb = {} as any;
    const digest = await buildSwarmDigest(mockDb, {
      companyId: "",
      projectId: null,
    });

    expect(digest.activeAgents).toEqual([]);
    expect(digest.activeRuns).toEqual([]);
    expect(digest.workspaces).toEqual([]);
    expect(digest.services).toEqual([]);
  });

  it("returns empty digest when db is not provided properly", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as any;

    const digest = await buildSwarmDigest(mockDb, {
      companyId: "company-1",
      projectId: null,
    });

    expect(digest.companyId).toBe("company-1");
    expect(digest.projectId).toBeNull();
    expect(digest.generatedAt).toBeTruthy();
  });
});

describe("formatSwarmDigestForPrompt", () => {
  it("returns minimal header for empty digest", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [],
      activeRuns: [],
      workspaces: [],
      services: [],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("## Coding Swarm Status");
    expect(formatted).not.toContain("### Active Agents");
    expect(formatted).not.toContain("### Active Runs");
  });

  it("formats active agents section", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [
        { id: "agent-1", name: "Alice", status: "running" },
        { id: "agent-2", name: "Bob", status: "paused" },
      ],
      activeRuns: [],
      workspaces: [],
      services: [],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("### Active Agents");
    expect(formatted).toContain("Alice");
    expect(formatted).toContain("(running)");
    // Paused agents are filtered out from display
    expect(formatted).not.toContain("Bob");
    expect(formatted).not.toContain("paused");
  });

  it("formats active runs with issue info", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [],
      activeRuns: [
        {
          id: "run-12345678",
          agentId: "agent-1",
          issueId: "issue-1",
          issueIdentifier: "PAP-42",
          issueTitle: "Fix login bug",
          status: "running",
          startedAt: new Date().toISOString(),
        },
      ],
      workspaces: [],
      services: [],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("### Active Runs");
    expect(formatted).toContain("PAP-42");
    expect(formatted).toContain("Fix login bug");
    expect(formatted).toContain("(running)");
  });

  it("formats active runs without issue info", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [],
      activeRuns: [
        {
          id: "run-12345678",
          agentId: "agent-1",
          issueId: null,
          issueIdentifier: null,
          issueTitle: null,
          status: "queued",
          startedAt: null,
        },
      ],
      workspaces: [],
      services: [],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("No issue");
    expect(formatted).toContain("(queued)");
  });

  it("formats workspaces with branch info", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [],
      activeRuns: [],
      workspaces: [
        {
          id: "ws-1",
          name: "feature-auth",
          branchName: "feature-auth",
          worktreePath: "/path/to/worktree",
          status: "active",
          sourceIssueId: "issue-1",
        },
      ],
      services: [],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("### Active Workspaces");
    expect(formatted).toContain("feature-auth");
    expect(formatted).toContain("branch:feature-auth");
  });

  it("formats runtime services with URLs", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: [],
      activeRuns: [],
      workspaces: [],
      services: [
        {
          id: "svc-1",
          serviceName: "web",
          status: "running",
          url: "http://localhost:3000",
          ownerAgentId: "agent-1",
        },
        {
          id: "svc-2",
          serviceName: "api",
          status: "starting",
          url: null,
          ownerAgentId: null,
        },
      ],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toContain("### Runtime Services");
    expect(formatted).toContain("web");
    expect(formatted).toContain("http://localhost:3000");
    expect(formatted).toContain("api");
    expect(formatted).toContain("(starting)");
  });

  it("limits output to reasonable sizes", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: new Date().toISOString(),
      activeAgents: Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        name: `Agent ${i}`,
        status: "running",
      })),
      activeRuns: Array.from({ length: 20 }, (_, i) => ({
        id: `run-${i}`,
        agentId: `agent-${i}`,
        issueId: `issue-${i}`,
        issueIdentifier: `PAP-${i}`,
        issueTitle: `Issue ${i}`,
        status: "running",
        startedAt: new Date().toISOString(),
      })),
      workspaces: Array.from({ length: 10 }, (_, i) => ({
        id: `ws-${i}`,
        name: `Workspace ${i}`,
        branchName: `branch-${i}`,
        worktreePath: `/path/${i}`,
        status: "active",
        sourceIssueId: null,
      })),
      services: Array.from({ length: 50 }, (_, i) => ({
        id: `svc-${i}`,
        serviceName: `service-${i}`,
        status: "running",
        url: `http://localhost:${3000 + i}`,
        ownerAgentId: null,
      })),
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    // Active runs limited to 10
    expect(formatted).toContain("### Active Runs");
    const runsSection = formatted.split("### Active Runs")[1]?.split("###")[0] || "";
    const runLines = runsSection.split("\n").filter((l: string) => l.includes("Run"));
    expect(runLines.length).toBeLessThanOrEqual(10);

    // Workspaces limited to 5
    expect(formatted).toContain("### Active Workspaces");
    const wsSection = formatted.split("### Active Workspaces")[1]?.split("###")[0] || "";
    const wsLines = wsSection.split("\n").filter((l: string) => l.includes("- "));
    expect(wsLines.length).toBeLessThanOrEqual(5);

    // Services limited to 10
    expect(formatted).toContain("### Runtime Services");
    const svcSection = formatted.split("### Runtime Services")[1]?.split("###")[0] || "";
    const svcLines = svcSection.split("\n").filter((l: string) => l.includes("- "));
    expect(svcLines.length).toBeLessThanOrEqual(10);
  });

  it("handles missing optional fields gracefully", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: null,
      generatedAt: new Date().toISOString(),
      activeAgents: [{ id: "agent-1", name: "Alice", status: "running" }],
      activeRuns: [
        {
          id: "run-1",
          agentId: "agent-1",
          issueId: null,
          issueIdentifier: null,
          issueTitle: null,
          status: "running",
          startedAt: null,
        },
      ],
      workspaces: [
        {
          id: "ws-1",
          name: "test-ws",
          branchName: null,
          worktreePath: null,
          status: "active",
          sourceIssueId: null,
        },
      ],
      services: [
        {
          id: "svc-1",
          serviceName: "web",
          status: "running",
          url: null,
          ownerAgentId: null,
        },
      ],
      fileClaimConflicts: [],
    };

    const formatted = formatSwarmDigestForPrompt(digest);

    expect(formatted).toBeTruthy();
    expect(formatted).toContain("## Coding Swarm Status");
    expect(formatted).toContain("Alice");
  });
});

describe("digest data structure integrity", () => {
  it("swarm digest has all required fields", () => {
    const digest: SwarmDigest = {
      companyId: "company-1",
      projectId: "project-1",
      generatedAt: "2024-01-01T00:00:00.000Z",
      activeAgents: [],
      activeRuns: [],
      workspaces: [],
      services: [],
      fileClaimConflicts: [],
    };

    expect(digest.companyId).toBe("company-1");
    expect(digest.projectId).toBe("project-1");
    expect(digest.generatedAt).toBeTruthy();
    expect(Array.isArray(digest.activeAgents)).toBe(true);
    expect(Array.isArray(digest.activeRuns)).toBe(true);
    expect(Array.isArray(digest.workspaces)).toBe(true);
    expect(Array.isArray(digest.services)).toBe(true);
    expect(Array.isArray(digest.fileClaimConflicts)).toBe(true);
  });
});

describe("buildHandoffComment", () => {
  it("produces comment with all required sections", () => {
    const comment = buildHandoffComment({
      agentId: "agent-1",
      agentName: "Alice",
      runId: "run-123",
      issueId: "issue-456",
      summary: "Implemented user authentication",
      filesTouched: ["src/auth/login.ts", "src/auth/session.ts"],
      currentState: "Login flow complete, session handling added",
      remainingWork: ["Add logout functionality", "Write auth tests"],
      blockers: ["Waiting on API spec"],
      recommendedNextStep: "Implement logout endpoint",
    });

    expect(comment).toContain(HANDOFF_COMMENT_PREFIX);
    expect(comment).toContain("<!-- AGENT_ID:agent-1 -->");
    expect(comment).toContain("<!-- AGENT_NAME:Alice -->");
    expect(comment).toContain("<!-- RUN_ID:run-123 -->");
    expect(comment).toContain("<!-- ISSUE_ID:issue-456 -->");
    expect(comment).toContain("## Summary");
    expect(comment).toContain("Implemented user authentication");
    expect(comment).toContain("## Files touched");
    expect(comment).toContain("- src/auth/login.ts");
    expect(comment).toContain("- src/auth/session.ts");
    expect(comment).toContain("## Current state");
    expect(comment).toContain("Login flow complete, session handling added");
    expect(comment).toContain("## Remaining work");
    expect(comment).toContain("- Add logout functionality");
    expect(comment).toContain("## Blockers");
    expect(comment).toContain("- Waiting on API spec");
    expect(comment).toContain("## Recommended next step");
    expect(comment).toContain("Implement logout endpoint");
  });

  it("escapes markdown-like content in values", () => {
    const comment = buildHandoffComment({
      agentId: "agent-1",
      agentName: "Bob",
      runId: "run-789",
      issueId: null,
      summary: "<!-- suspicious --> test",
      filesTouched: [],
      currentState: "Working on <!-- comment --> here",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "Next: <!-- more --> steps",
    });

    expect(comment).toContain("<!--~ suspicious ~-->");
    expect(comment).not.toContain("<!-- suspicious -->");
    expect(comment).toContain("<!--~ comment ~-->");
    expect(comment).not.toContain("<!-- comment -->");
  });

  it("handles empty optional arrays", () => {
    const comment = buildHandoffComment({
      agentId: "agent-1",
      agentName: "Charlie",
      runId: "run-000",
      issueId: "issue-1",
      summary: "Minimal handoff",
      filesTouched: [],
      currentState: "Done",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "Review and merge",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("## Files touched");
    expect(comment).toContain("## Current state");
    expect(comment).toContain("## Remaining work");
    expect(comment).not.toContain("## Blockers");
    expect(comment).toContain("## Recommended next step");
  });

  it("includes emitted timestamp", () => {
    const before = new Date().toISOString();
    const comment = buildHandoffComment({
      agentId: "agent-1",
      agentName: "Dave",
      runId: "run-001",
      issueId: null,
      summary: "Test",
      filesTouched: [],
      currentState: "Testing",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "Done",
    });
    const after = new Date().toISOString();

    expect(comment).toMatch(/<!-- EMITTED_AT:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("parseHandoffComment", () => {
  it("parses full handoff comment correctly", () => {
    const handoff: StructuredHandoff = {
      version: "1.0",
      agentId: "agent-abc",
      agentName: "Eve",
      runId: "run-xyz",
      issueId: "issue-123",
      summary: "Added feature X",
      filesTouched: ["src/feature/x.ts", "src/feature/y.ts"],
      currentState: "Feature X implemented and tested",
      remainingWork: ["Update docs", "Add integration tests"],
      blockers: ["Waiting on API spec"],
      recommendedNextStep: "Update README with new endpoints",
      emittedAt: "2024-01-15T10:30:00.000Z",
    };

    const comment = buildHandoffComment({
      agentId: handoff.agentId,
      agentName: handoff.agentName,
      runId: handoff.runId,
      issueId: handoff.issueId,
      summary: handoff.summary,
      filesTouched: handoff.filesTouched,
      currentState: handoff.currentState,
      remainingWork: handoff.remainingWork,
      blockers: handoff.blockers,
      recommendedNextStep: handoff.recommendedNextStep,
    });

    const parsed = parseHandoffComment(comment);

    expect(parsed).not.toBeNull();
    expect(parsed!.agentId).toBe("agent-abc");
    expect(parsed!.agentName).toBe("Eve");
    expect(parsed!.runId).toBe("run-xyz");
    expect(parsed!.issueId).toBe("issue-123");
    expect(parsed!.summary).toBe("Added feature X");
    expect(parsed!.filesTouched).toEqual(["src/feature/x.ts", "src/feature/y.ts"]);
    expect(parsed!.currentState).toBe("Feature X implemented and tested");
    expect(parsed!.remainingWork).toEqual(["Update docs", "Add integration tests"]);
    expect(parsed!.blockers).toEqual(["Waiting on API spec"]);
    expect(parsed!.recommendedNextStep).toBe("Update README with new endpoints");
  });

  it("returns null for non-handoff comments", () => {
    const regularComment = "Just a regular comment on the issue.";
    expect(parseHandoffComment(regularComment)).toBeNull();
    expect(isHandoffComment(regularComment)).toBe(false);
  });

  it("returns true for handoff comment via isHandoffComment", () => {
    const comment = buildHandoffComment({
      agentId: "a",
      agentName: "b",
      runId: "c",
      issueId: null,
      summary: "x",
      filesTouched: [],
      currentState: "y",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "z",
    });

    expect(isHandoffComment(comment)).toBe(true);
    expect(isHandoffComment("Not a handoff")).toBe(false);
  });

  it("handles null issueId in parsing", () => {
    const comment = buildHandoffComment({
      agentId: "agent-1",
      agentName: "Test",
      runId: "run-1",
      issueId: null,
      summary: "Summary",
      filesTouched: [],
      currentState: "State",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "Next",
    });

    const parsed = parseHandoffComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.issueId).toBeNull();
  });

  it("unescapes escaped content on parse", () => {
    const comment = buildHandoffComment({
      agentId: "a",
      agentName: "b",
      runId: "c",
      issueId: null,
      summary: "Text with <!-- cdata --> inside",
      filesTouched: [],
      currentState: "State <!-- has --> comment",
      remainingWork: [],
      blockers: [],
      recommendedNextStep: "Step",
    });

    const parsed = parseHandoffComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe("Text with <!-- cdata --> inside");
    expect(parsed!.currentState).toBe("State <!-- has --> comment");
  });
});

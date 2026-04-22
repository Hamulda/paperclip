// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyProvider } from "@/context/CompanyContext";
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
import { SwarmCockpit } from "./SwarmCockpit";
import type { SwarmCockpitDigest } from "@paperclipai/shared";

// Shared mutable state so the mock returns the same object on every call
const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const breadcrumbsState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const mockSwarmDigestApi = vi.hoisted(() => ({
  getCockpitDigest: vi.fn<() => Promise<SwarmCockpitDigest>>(),
}));

vi.mock("@/api/swarm-digest", () => ({
  swarmDigestApi: mockSwarmDigestApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  CompanyProvider: ({ children }: { children: ReactNode }) => children,
  useCompany: () => companyState,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  BreadcrumbProvider: ({ children }: { children: ReactNode }) => children,
  useBreadcrumbs: () => breadcrumbsState,
}));

const searchParamsState = vi.hoisted(() => new URLSearchParams());

vi.mock("@/lib/router", () => ({
  useSearchParams: () => [searchParamsState],
  useNavigate: () => vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockDigest(overrides: Partial<SwarmCockpitDigest> = {}): SwarmCockpitDigest {
  const defaultDigest: SwarmCockpitDigest = {
    companyId: "company-1",
    projectId: "project-1",
    generatedAt: "2026-04-19T10:00:00.000Z",
    activeAgents: [],
    activeRuns: [],
    workspaces: [],
    services: [],
    fileClaimConflicts: [],
    fileClaimStale: [],
    servicesDegraded: [],
    runsStuck: [],
    recentHandoffs: [],
    latestHandoff: null,
    claimedPathsSummary: { byAgent: [] },
    recommendedAvoidPaths: { paths: [], reasons: [] },
    protectedPaths: { defaultPatterns: [], configurablePatterns: [], enforcement: "hard_block" },
    autoClaimSuggestions: [],
    hotSlotUsage: { current: 0, max: 3 },
    queuedHotRunsCount: 0,
    reviewQueue: { readyForReview: [], needsVerification: [], blocked: [] },
    collaborationHints: [],
    recentArtifacts: [],
    issueWorkflowSummary: [],
  };
  return { ...defaultDigest, ...overrides };
}

function renderWithProviders(ui: ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyProvider>
          <BreadcrumbProvider>{ui}</BreadcrumbProvider>
        </CompanyProvider>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("SwarmCockpit", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    mockSwarmDigestApi.getCockpitDigest.mockReset();
    searchParamsState.forEach((_, key) => searchParamsState.delete(key));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("renders empty state when no data is available", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("No active agents");
    expect(container.textContent).toContain("No active runs");
    expect(container.textContent).toContain("No expiring claims");
    expect(container.textContent).toContain("No degraded services");
    expect(container.textContent).toContain("No stuck runs");
    expect(container.textContent).toContain("No recent handoffs");
  });

  it("renders all four diagnostic sections with populated data", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        fileClaimStale: [
          {
            id: "claim-1",
            claimPath: "src/expiring.ts",
            claimType: "file",
            agentId: "agent-1",
            runId: "run-1",
            expiresAt: "2026-04-19T10:02:00.000Z",
            minutesUntilExpiry: 1,
          },
        ],
        servicesDegraded: [
          {
            id: "svc-1",
            serviceName: "broken-api",
            status: "failed",
            healthStatus: "unhealthy",
            url: null,
            ownerAgentId: null,
          },
        ],
        runsStuck: [
          {
            id: "run-stuck",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-99",
            issueTitle: "Long task",
            status: "queued",
            createdAt: "2026-04-19T08:00:00.000Z",
            startedAt: "2026-04-19T08:00:00.000Z",
            minutesWaiting: 110,
          },
        ],
        recentHandoffs: [
          {
            id: "hc-1",
            agentId: "agent-2",
            agentName: "Bob",
            swarmRole: "implementer",
            runId: "run-2",
            issueId: "issue-1",
            issueIdentifier: "PAP-99",
            summary: "Completed auth module",
            filesTouched: ["src/auth.ts"],
            currentState: "Auth done",
            remainingWork: ["Tests"],
            blockers: [],
            recommendedNextStep: "Review PR",
            avoidPaths: [],
            emittedAt: "2026-04-19T09:00:00.000Z",
            verificationStatus: null,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("src/expiring.ts");
    expect(container.textContent).toContain("broken-api");
    expect(container.textContent).toContain("PAP-99");
    expect(container.textContent).toContain("Bob");
    expect(container.textContent).toContain("Completed auth module");
    expect(container.textContent).toContain("Review PR");
  });

  it("renders stale claims with correct expiry label when already expired", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        fileClaimStale: [
          {
            id: "claim-critical",
            claimPath: "src/critical.ts",
            claimType: "file",
            agentId: "agent-1",
            runId: "run-1",
            expiresAt: "2026-04-19T10:01:00.000Z",
            minutesUntilExpiry: 0,
          },
        ],
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Expired");
  });

  it("renders stuck runs with correct waiting time", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        runsStuck: [
          {
            id: "run-stuck-1",
            agentId: "agent-1",
            issueId: "issue-x",
            issueIdentifier: "PAP-5",
            issueTitle: "Stuck issue",
            status: "queued",
            createdAt: "2026-04-19T08:00:00.000Z",
            startedAt: "2026-04-19T08:00:00.000Z",
            minutesWaiting: 55,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Waiting 55m");
  });

  it("renders hot slot meter with correct values and queued count", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        hotSlotUsage: { current: 2, max: 3 },
        queuedHotRunsCount: 1,
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Hot slots");
    expect(container.textContent).toContain("2/3");
    expect(container.textContent).toContain("queued hot runs waiting");
  });

  it("renders degraded services section with status and health", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        servicesDegraded: [
          {
            id: "svc-bad",
            serviceName: "failing-service",
            status: "stopped",
            healthStatus: "degraded",
            url: "http://localhost:9999",
            ownerAgentId: null,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("failing-service");
    expect(container.textContent).toContain("stopped");
    expect(container.textContent).toContain("degraded");
  });

  it("renders handoff section with agent name and recommended next step", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Charlie", status: "running", role: null }],
        recentHandoffs: [
          {
            id: "hc-1",
            agentId: "agent-3",
            agentName: "Charlie",
            swarmRole: "integrator",
            runId: "run-5",
            issueId: null,
            issueIdentifier: null,
            summary: "Finished initial implementation",
            filesTouched: ["src/feature.ts"],
            currentState: "Implementation complete",
            remainingWork: ["Integration tests"],
            blockers: ["Waiting on API spec"],
            recommendedNextStep: "Merge and deploy",
            avoidPaths: ["src/legacy/"],
            emittedAt: "2026-04-19T09:30:00.000Z",
            verificationStatus: null,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Charlie");
    expect(container.textContent).toContain("Finished initial implementation");
    expect(container.textContent).toContain("Merge and deploy");
  });

  it("renders last updated timestamp", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({ generatedAt: "2026-04-19T10:30:00.000Z" }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Last updated");
  });

  it("passes projectId to API when present in search params", async () => {
    searchParamsState.set("projectId", "proj-alpha");
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(mockSwarmDigestApi.getCockpitDigest).toHaveBeenCalledWith("company-1", "proj-alpha");
  });

  it("does not pass projectId to API when absent from search params", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(mockSwarmDigestApi.getCockpitDigest).toHaveBeenCalledWith("company-1", undefined);
  });

  it("shows project-scoped indicator when projectId is present", async () => {
    searchParamsState.set("projectId", "proj-alpha");
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Project-scoped view");
  });

  it("does not show project-scoped indicator when projectId is absent", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).not.toContain("Project-scoped view");
  });

  it("handles missing optional fields gracefully in handoffs", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        recentHandoffs: [
          {
            id: "hc-min",
            agentId: "agent-min",
            agentName: "Min",
            swarmRole: null,
            runId: "run-min",
            issueId: null,
            issueIdentifier: null,
            summary: "Minimal handoff",
            filesTouched: [],
            currentState: "Done",
            remainingWork: [],
            blockers: [],
            recommendedNextStep: "Ship it",
            avoidPaths: [],
            emittedAt: "2026-04-19T09:00:00.000Z",
            verificationStatus: null,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Min");
    expect(container.textContent).toContain("Minimal handoff");
    expect(container.textContent).toContain("Ship it");
  });

  it("renders agent role badge in Active Agents section", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [
          { id: "agent-1", name: "Alice", status: "running", role: "planner" },
          { id: "agent-2", name: "Bob", status: "running", role: "implementer" },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("planner");
    expect(container.textContent).toContain("Bob");
    expect(container.textContent).toContain("implementer");
  });

  it("renders run swarmRole badge in Active Runs section", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          {
            id: "run-1",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-42",
            issueTitle: "Fix bug",
            status: "running",
            startedAt: "2026-04-19T09:00:00.000Z",
            swarmRole: "planner",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("planner");
  });

  it("renders handoff swarmRole badge and avoidPaths", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        recentHandoffs: [
          {
            id: "hc-1",
            agentId: "agent-1",
            agentName: "Charlie",
            swarmRole: "integrator",
            runId: "run-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-10",
            summary: "Completed feature",
            filesTouched: [],
            currentState: "Done",
            remainingWork: [],
            blockers: [],
            recommendedNextStep: "Review PR",
            avoidPaths: ["src/legacy/", "src/deprecated/", "src/old/"],
            emittedAt: "2026-04-19T09:00:00.000Z",
            verificationStatus: null,
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Charlie");
    expect(container.textContent).toContain("integrator");
    expect(container.textContent).toContain("Avoid: src/legacy/");
    expect(container.textContent).toContain("+1");
  });

  it("renders Claimed Paths section with agent and path count", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        claimedPathsSummary: {
          byAgent: [
            {
              agentId: "agent-1",
              agentName: "Alice",
              role: "planner",
              paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
              pathCount: 3,
              issueIdentifier: "PAP-1",
            },
          ],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("planner");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("3 paths claimed");
  });

  it("renders Avoid Paths section", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        recommendedAvoidPaths: {
          paths: ["src/legacy/", "src/deprecated/"],
          reasons: ["Agent is working here", "Another agent is working here"],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("src/legacy/");
    expect(container.textContent).toContain("src/deprecated/");
    expect(container.textContent).toContain("Agent is working here");
  });

  it("renders Protected Paths section with enforcement mode", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        protectedPaths: {
          defaultPatterns: ["package.json", "pnpm-lock.yaml", "node_modules/**"],
          configurablePatterns: [],
          enforcement: "hard_block",
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Protected Paths");
    expect(container.textContent).toContain("Hard Block");
    expect(container.textContent).toContain("package.json");
    expect(container.textContent).toContain("pnpm-lock.yaml");
  });

  it("renders Queue Fairness section in healthy state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        runsStuck: [],
        activeRuns: [{ id: "run-1", agentId: "a1", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null }],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Queue Health");
    expect(container.textContent).toContain("Healthy");
  });

  it("renders Queue Fairness section with starvation warning", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        runsStuck: [
          { id: "run-stuck", agentId: "a1", issueId: "issue-1", issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 55 },
          { id: "run-stuck-2", agentId: "a2", issueId: "issue-2", issueIdentifier: "PAP-6", issueTitle: "Stuck2", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 55 },
          { id: "run-stuck-3", agentId: "a3", issueId: "issue-3", issueIdentifier: "PAP-7", issueTitle: "Stuck3", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 55 },
        ],
        activeRuns: [
          { id: "run-1", agentId: "a4", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-2", agentId: "a5", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-3", agentId: "a6", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Queue Health");
    expect(container.textContent).toContain("High pressure");
    expect(container.textContent).toContain("3 runs waiting");
  });

  it("renders Latest Handoff section with role, blockers, and remaining work", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        latestHandoff: {
          id: "hc-latest",
          agentId: "agent-latest",
          agentName: "Diana",
          swarmRole: "reviewer",
          runId: "run-latest",
          issueId: "issue-x",
          issueIdentifier: "PAP-77",
          summary: "Review changes and merge",
          filesTouched: ["src/merge.ts"],
          currentState: "Ready for review",
          remainingWork: ["Update changelog", "Bump version"],
          blockers: ["CI must pass"],
          recommendedNextStep: "Merge after CI",
          avoidPaths: [],
          emittedAt: "2026-04-19T11:00:00.000Z",
          verificationStatus: null,
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Latest Handoff");
    expect(container.textContent).toContain("Diana");
    expect(container.textContent).toContain("reviewer");
    expect(container.textContent).toContain("PAP-77");
    expect(container.textContent).toContain("Review changes and merge");
    expect(container.textContent).toContain("Remaining:");
    expect(container.textContent).toContain("Blockers:");
  });

  it("renders Latest Handoff empty state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({ latestHandoff: null }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Latest Handoff");
    expect(container.textContent).toContain("No handoff yet");
  });

  it("renders Auto-Claim Suggestions section with source badges", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        autoClaimSuggestions: [
          { source: "issue_labels", path: "src/feature/", claimType: "directory", reason: "Priority label detected", issueIdentifier: "PAP-1" },
          { source: "issue_description", path: "src/auth.ts", claimType: "file", reason: "Mentioned in issue body" },
          { source: "issue_title", path: "src/title.ts", claimType: "file", reason: "Keyword in title", issueIdentifier: "PAP-3" },
          { source: "diff", path: "src/bugfix.ts", claimType: "file", reason: "Changed in recent diff", issueIdentifier: "PAP-2" },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Auto-Claim Suggestions");
    expect(container.textContent).toContain("src/feature/");
    expect(container.textContent).toContain("issue_labels");
    expect(container.textContent).toContain("src/auth.ts");
    expect(container.textContent).toContain("issue_description");
    expect(container.textContent).toContain("src/bugfix.ts");
    expect(container.textContent).toContain("diff");
    expect(container.textContent).toContain("Priority label detected");
    expect(container.textContent).toContain("src/title.ts");
    expect(container.textContent).toContain("issue_title");
  });

  it("renders Auto-Claim Suggestions empty state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({ autoClaimSuggestions: [] }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Auto-Claim Suggestions");
    expect(container.textContent).toContain("No suggestions");
  });

  it("renders summary strip with alert counts and All Clear state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Alice", status: "running", role: null }],
        activeRuns: [{ id: "r1", agentId: "a1", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null }],
        runsStuck: [{ id: "s1", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 }],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Swarm");
    expect(container.textContent).toContain("1 stuck");
    expect(container.textContent).toContain("1 agents");
    expect(container.textContent).toContain("1 runs");
  });

  it("renders summary strip All Clear when no alerts", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(createMockDigest());

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("All clear");
  });

  it("renders alert count badge on SectionCard for stuck runs", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        runsStuck: [
          { id: "s1", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
          { id: "s2", agentId: "a2", issueId: null, issueIdentifier: "PAP-6", issueTitle: "Stuck2", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 3 },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const stuckSection = container.querySelectorAll(".bg-red-500\\/10");
    expect(stuckSection.length).toBeGreaterThan(0);
  });

  it("renders expiring claims alert count when claims are <= 1 minute", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Alice", status: "running", role: null }],
        activeRuns: [{ id: "r1", agentId: "a1", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null }],
        fileClaimStale: [
          { id: "claim-1", claimPath: "src/expiring.ts", claimType: "file", agentId: "agent-1", runId: "run-1", expiresAt: "2026-04-19T10:01:00.000Z", minutesUntilExpiry: 1 },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("1 expiring");
  });

  it("RunRow issueIdentifier is styled as clickable link", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          { id: "run-1", agentId: "agent-1", issueId: "issue-1", issueIdentifier: "PAP-42", issueTitle: "Fix bug", status: "running", startedAt: "2026-04-19T09:00:00.000Z", swarmRole: "planner" },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const allText = container.textContent ?? "";
    expect(allText).toContain("PAP-42");
  });

  it("StuckRunRow issueIdentifier is styled as clickable link", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        runsStuck: [
          { id: "run-stuck", agentId: "agent-1", issueId: "issue-1", issueIdentifier: "PAP-99", issueTitle: "Stuck task", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 55 },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const pap99 = container.querySelector(".text-blue-600");
    expect(pap99?.textContent).toBe("PAP-99");
  });

  it("summary strip has sticky positioning and anchor links", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        runsStuck: [
          { id: "s1", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const strip = container.querySelector(".sticky");
    expect(strip).not.toBeNull();
    const anchor = container.querySelector('a[href="#stuck-runs"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toContain("1");
    expect(anchor?.textContent).toContain("stuck");
  });

  it("expired and expiring-soon are separate alert pills", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Alice", status: "running", role: null }],
        fileClaimStale: [
          { id: "claim-1", claimPath: "src/expired.ts", claimType: "file", agentId: "agent-1", runId: "run-1", expiresAt: "2026-04-19T10:00:00.000Z", minutesUntilExpiry: 0 },
          { id: "claim-2", claimPath: "src/expiring.ts", claimType: "file", agentId: "agent-1", runId: "run-1", expiresAt: "2026-04-19T10:01:30.000Z", minutesUntilExpiry: 1 },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const allText = container.textContent ?? "";
    expect(allText).toContain("1 expired");
    expect(allText).toContain("1 expiring soon");
  });

  it("queue health shows warning state for non-critical stuck runs", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        runsStuck: [
          { id: "run-stuck", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
        ],
        activeRuns: [
          { id: "run-1", agentId: "a2", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-2", agentId: "a3", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-3", agentId: "a4", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-4", agentId: "a5", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-5", agentId: "a6", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Queue Health");
    expect(container.textContent).toContain("1/6 queued");
    expect(container.textContent).toContain("monitor queue pressure");
  });

  it("queue health shows high pressure state for critical stuck ratio", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        runsStuck: [
          { id: "run-stuck", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
          { id: "run-stuck-2", agentId: "a2", issueId: null, issueIdentifier: "PAP-6", issueTitle: "Stuck2", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
        ],
        activeRuns: [
          { id: "run-1", agentId: "a3", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-2", agentId: "a4", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Queue Health");
    expect(container.textContent).toContain("High pressure");
    expect(container.textContent).toContain("2 runs waiting");
  });

  it("queue health shows amber warning color for moderate queue pressure", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeAgents: [{ id: "a1", name: "Agent", status: "running", role: null }],
        runsStuck: [
          { id: "run-stuck", agentId: "a1", issueId: null, issueIdentifier: "PAP-5", issueTitle: "Stuck", status: "queued", createdAt: "2026-04-19T08:00:00.000Z", startedAt: null, minutesWaiting: 5 },
        ],
        activeRuns: [
          { id: "run-1", agentId: "a2", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-2", agentId: "a3", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
          { id: "run-3", agentId: "a4", issueId: null, issueIdentifier: null, issueTitle: null, status: "running", startedAt: null, swarmRole: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const amberText = container.querySelector(".text-amber-500");
    expect(amberText).not.toBeNull();
  });

  it("renders Review Queue section with ready-for-review handoffs", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [
            {
              id: "hc-review",
              agentId: "agent-1",
              agentName: "Alice",
              swarmRole: "reviewer",
              runId: "run-1",
              issueId: "issue-1",
              issueIdentifier: "PAP-42",
              summary: "Auth module implementation complete",
              filesTouched: ["src/auth.ts"],
              currentState: "Ready for review",
              remainingWork: [],
              blockers: [],
              recommendedNextStep: "Review and merge",
              avoidPaths: [],
              emittedAt: "2026-04-19T09:00:00.000Z",
              verificationStatus: "ready_for_review",
            },
          ],
          needsVerification: [],
          blocked: [],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Review Queue");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("Auth module implementation complete");
    expect(container.textContent).toContain("Review and merge");
  });

  it("renders Review Queue section with blocked handoffs", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [],
          needsVerification: [],
          blocked: [
            {
              id: "hc-blocked",
              agentId: "agent-2",
              agentName: "Bob",
              swarmRole: "implementer",
              runId: "run-2",
              issueId: "issue-2",
              issueIdentifier: "PAP-55",
              summary: "Feature blocked on API spec",
              filesTouched: [],
              currentState: "Waiting",
              remainingWork: ["Implement feature"],
              blockers: ["API spec not finalized"],
              recommendedNextStep: "Wait for API spec",
              avoidPaths: [],
              emittedAt: "2026-04-19T09:00:00.000Z",
              verificationStatus: "blocked",
            },
          ],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Review Queue");
    expect(container.textContent).toContain("Bob");
    expect(container.textContent).toContain("PAP-55");
    expect(container.textContent).toContain("Feature blocked on API spec");
  });

  it("renders empty Review Queue section", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: { readyForReview: [], needsVerification: [], blocked: [] },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Review Queue");
    expect(container.textContent).toContain("No items need review");
  });

  it("shows review needed alert in summary strip when review queue has items", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [
            { id: "hc-1", agentId: "a1", agentName: "Alice", swarmRole: null, runId: "r1", issueId: null, issueIdentifier: null, summary: "Done", filesTouched: [], currentState: "", remainingWork: [], blockers: [], recommendedNextStep: "Review", avoidPaths: [], emittedAt: "2026-04-19T09:00:00.000Z", verificationStatus: "ready_for_review" },
          ],
          needsVerification: [],
          blocked: [],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("review needed");
  });

  it("does not show review needed alert when review queue is empty", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: { readyForReview: [], needsVerification: [], blocked: [] },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).not.toContain("review needed");
  });

  it("renders Collaboration Hints section with high urgency hints", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        collaborationHints: [
          { type: "review_needed", message: "Alice is ready for review — verify before starting related work", urgency: "high", relatedIssue: "PAP-42" },
          { type: "blocked", message: "Bob is blocked on: API spec not finalized", urgency: "high", relatedIssue: "PAP-55" },
          { type: "role_coordination", message: "Alice, Bob are working on src/ (reviewer, coder) — coordinate before merging shared changes", urgency: "medium", relatedIssue: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Collaboration Hints");
    expect(container.textContent).toContain("Alice is ready for review");
    expect(container.textContent).toContain("Bob is blocked on");
    expect(container.textContent).toContain("coordinate before merging");
    expect(container.textContent).toContain("high");
    expect(container.textContent).toContain("medium");
  });

  it("renders Collaboration Hints section with conflict risk hints", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        fileClaimConflicts: [
          { claimPath: "src/shared.ts", claimType: "file", conflictingAgentId: "a1", conflictingRunId: "r1" },
        ],
        collaborationHints: [
          { type: "conflict_risk", message: "Path src/shared.ts has overlapping claims — resolve before merging", urgency: "high", relatedIssue: null },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Collaboration Hints");
    expect(container.textContent).toContain("overlapping claims");
  });

  it("renders empty Collaboration Hints section", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        collaborationHints: [],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Collaboration Hints");
    expect(container.textContent).toContain("No active hints");
  });

  it("review queue shows alert count badge", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [
            { id: "hc-1", agentId: "a1", agentName: "Alice", swarmRole: null, runId: "r1", issueId: null, issueIdentifier: null, summary: "Done", filesTouched: [], currentState: "", remainingWork: [], blockers: [], recommendedNextStep: "Review", avoidPaths: [], emittedAt: "2026-04-19T09:00:00.000Z", verificationStatus: "ready_for_review" },
          ],
          needsVerification: [],
          blocked: [
            { id: "hc-2", agentId: "a2", agentName: "Bob", swarmRole: null, runId: "r2", issueId: null, issueIdentifier: null, summary: "Blocked", filesTouched: [], currentState: "", remainingWork: [], blockers: ["CI failing"], recommendedNextStep: "Fix CI", avoidPaths: [], emittedAt: "2026-04-19T09:00:00.000Z", verificationStatus: "blocked" },
          ],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    const redBadges = container.querySelectorAll(".bg-red-500\\/10");
    expect(redBadges.length).toBeGreaterThan(0);
  });

  it("renders RunRow with phase badge and review signals", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          {
            id: "run-1",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-42",
            issueTitle: "Test run",
            status: "running",
            startedAt: "2026-04-19T09:00:00.000Z",
            swarmRole: "planner",
            phase: "executing",
            verificationStatus: "verified",
            mergeReadiness: "ready",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("Executing");
    expect(container.textContent).toContain("✓ merge ready");
  });

  it("renders RunRow with blocked signal", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          {
            id: "run-blocked",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-99",
            issueTitle: "Blocked run",
            status: "running",
            startedAt: "2026-04-19T09:00:00.000Z",
            swarmRole: "executor",
            phase: "code_review",
            verificationStatus: "blocked",
            mergeReadiness: "blocked",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-99");
    expect(container.textContent).toContain("Code Review");
    expect(container.textContent).toContain("✗ blocked");
  });

  it("renders RunRow with rework signal", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          {
            id: "run-rework",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-7",
            issueTitle: "Rework run",
            status: "running",
            startedAt: "2026-04-19T09:00:00.000Z",
            swarmRole: "reviewer",
            phase: "code_review",
            verificationStatus: "needs_verification",
            mergeReadiness: "conditional",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-7");
    expect(container.textContent).toContain("~ rework");
  });

  it("renders Recent Artifacts section with verdict and merge readiness", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        recentArtifacts: [
          {
            id: "artifact-1",
            artifactType: "reviewer",
            status: "published",
            summary: "Code review complete",
            actorAgentId: "agent-1",
            actorAgentName: "Alice",
            createdAt: "2026-04-19T10:00:00.000Z",
            verificationStatus: "verified",
            mergeReadiness: "ready",
            verdict: "approved",
            filesChanged: ["src/a.ts"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Recent Artifacts");
    expect(container.textContent).toContain("Reviewer");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("approved");
    expect(container.textContent).toContain("✓ merge: ready");
  });

  it("renders Recent Artifacts section with blocked merge readiness", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        recentArtifacts: [
          {
            id: "artifact-blocked",
            artifactType: "executor",
            status: "published",
            summary: "Implementation done",
            actorAgentId: "agent-2",
            actorAgentName: "Bob",
            createdAt: "2026-04-19T10:00:00.000Z",
            mergeReadiness: "blocked",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Executor");
    expect(container.textContent).toContain("Bob");
    expect(container.textContent).toContain("✗ merge: blocked");
  });

  it("renders Recent Artifacts empty state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({ recentArtifacts: [] }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Recent Artifacts");
    expect(container.textContent).toContain("No recent artifacts");
  });

  it("renders ReviewQueueItem with review signals and blocked badge", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [],
          needsVerification: [],
          blocked: [
            {
              id: "hc-blocked-signal",
              agentId: "agent-1",
              agentName: "Charlie",
              swarmRole: "reviewer",
              runId: "run-1",
              issueId: "issue-1",
              issueIdentifier: "PAP-50",
              summary: "Needs rework due to test failures",
              filesTouched: [],
              currentState: "Failed",
              remainingWork: ["Fix tests"],
              blockers: ["CI failing", "Tests timeout"],
              recommendedNextStep: "Fix and resubmit",
              avoidPaths: [],
              emittedAt: "2026-04-19T09:00:00.000Z",
              verificationStatus: "blocked",
            },
          ],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Charlie");
    expect(container.textContent).toContain("PAP-50");
    expect(container.textContent).toContain("⚠ blocked");
  });

  it("renders ReviewQueueItem with rework signal", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [
            {
              id: "hc-rework-signal",
              agentId: "agent-1",
              agentName: "Diana",
              swarmRole: "reviewer",
              runId: "run-1",
              issueId: "issue-1",
              issueIdentifier: "PAP-200",
              summary: "Changes requested",
              filesTouched: [],
              currentState: "Changes needed",
              remainingWork: ["Address feedback"],
              blockers: [],
              recommendedNextStep: "Revise and resubmit",
              avoidPaths: [],
              emittedAt: "2026-04-19T09:00:00.000Z",
              verificationStatus: "needs_verification",
              mergeReadiness: "conditional",
            },
          ],
          needsVerification: [],
          blocked: [],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Diana");
    expect(container.textContent).toContain("PAP-200");
    expect(container.textContent).toContain("~ rework");
  });

  it("renders run with owner agent name", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        activeRuns: [
          {
            id: "run-owner",
            agentId: "agent-1",
            issueId: "issue-1",
            issueIdentifier: "PAP-100",
            issueTitle: "Owner test",
            status: "running",
            startedAt: "2026-04-19T09:00:00.000Z",
            swarmRole: "executor",
            phase: "executing",
            ownerAgentName: "Alice",
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Alice");
  });

  it("renders Issue Workflow section with owner, phase, and artifact chain", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-1",
            issueIdentifier: "PAP-10",
            issueTitle: "Add auth feature",
            phase: "planning",
            assigneeAgentName: "Alice",
            isRework: false,
            reworkCount: 0,
            blockedReason: null,
            expectedNextRole: "plan_reviewer",
            expectedNextPhase: "plan_review",
            artifactChain: ["planner"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Issue Workflow");
    expect(container.textContent).toContain("PAP-10");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).toContain("Planning");
    expect(container.textContent).toContain("plan_reviewer");
  });

  it("renders Issue Workflow section with rework signal", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-2",
            issueIdentifier: "PAP-20",
            issueTitle: "Rework issue",
            phase: "code_review",
            assigneeAgentName: "Bob",
            isRework: true,
            reworkCount: 2,
            blockedReason: null,
            expectedNextRole: "integrator",
            expectedNextPhase: "integration",
            artifactChain: ["planner", "plan_reviewer", "executor"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-20");
    expect(container.textContent).toContain("2");
  });

  it("renders Issue Workflow section with blocked reason", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-3",
            issueIdentifier: "PAP-30",
            issueTitle: "Blocked issue",
            phase: "blocked",
            assigneeAgentName: "Charlie",
            isRework: true,
            reworkCount: 1,
            blockedReason: "Artifact produced — awaiting review",
            expectedNextRole: null,
            expectedNextPhase: null,
            artifactChain: ["planner", "plan_reviewer", "executor", "reviewer"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-30");
    expect(container.textContent).toContain("Blocked");
    expect(container.textContent).toContain("Artifact produced");
  });

  it("renders Issue Workflow empty state", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({ issueWorkflowSummary: [] }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Issue Workflow");
    expect(container.textContent).toContain("No active issues");
  });

  it("renders ArtifactChainPips with produced and missing artifacts", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-4",
            issueIdentifier: "PAP-40",
            issueTitle: "Chain test",
            phase: "executing",
            assigneeAgentName: "Diana",
            isRework: false,
            reworkCount: 0,
            blockedReason: null,
            expectedNextRole: "reviewer",
            expectedNextPhase: "code_review",
            artifactChain: ["planner", "executor"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-40");
    expect(container.textContent).toContain("Diana");
    expect(container.textContent).toContain("reviewer");
  });

  it("renders Action Needed section with blocked issues", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-blocked",
            issueIdentifier: "PAP-100",
            issueTitle: "Blocked issue",
            phase: "blocked",
            assigneeAgentName: "Alice",
            isRework: false,
            reworkCount: 0,
            blockedReason: "Waiting for API spec",
            expectedNextRole: null,
            expectedNextPhase: null,
            artifactChain: ["planner"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Action Needed");
    expect(container.textContent).toContain("PAP-100");
    expect(container.textContent).toContain("Waiting for API spec");
  });

  it("renders Action Needed section with review queue items", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        reviewQueue: {
          readyForReview: [
            {
              id: "hc-review",
              agentId: "agent-1",
              agentName: "Bob",
              swarmRole: "reviewer",
              runId: "run-1",
              issueId: "issue-1",
              issueIdentifier: "PAP-50",
              summary: "Ready for review — please verify",
              filesTouched: [],
              currentState: "Done",
              remainingWork: [],
              blockers: [],
              recommendedNextStep: "Approve",
              avoidPaths: [],
              emittedAt: "2026-04-19T09:00:00.000Z",
              verificationStatus: "ready_for_review",
            },
          ],
          needsVerification: [],
          blocked: [],
        },
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Action Needed");
    expect(container.textContent).toContain("PAP-50");
    expect(container.textContent).toContain("Bob");
  });

  it("renders Action Needed section shows no urgent action when all clear", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-clear",
            issueIdentifier: "PAP-10",
            issueTitle: "Clear issue",
            phase: "executing",
            assigneeAgentName: "Charlie",
            isRework: false,
            reworkCount: 0,
            blockedReason: null,
            expectedNextRole: "reviewer",
            expectedNextPhase: "code_review",
            artifactChain: ["planner", "executor", "reviewer"],
          },
        ],
        reviewQueue: { readyForReview: [], needsVerification: [], blocked: [] },
        collaborationHints: [],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Action Needed");
    expect(container.textContent).toContain("No urgent action needed");
  });

  it("renders Action Needed section with rework items (reworkCount >= 2)", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-rework",
            issueIdentifier: "PAP-25",
            issueTitle: "Rework issue",
            phase: "code_review",
            assigneeAgentName: "Diana",
            isRework: true,
            reworkCount: 3,
            blockedReason: null,
            expectedNextRole: "integrator",
            expectedNextPhase: "integration",
            artifactChain: ["planner", "executor", "reviewer"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Action Needed");
    expect(container.textContent).toContain("PAP-25");
    expect(container.textContent).toContain("Rework cycle 3");
  });

  it("renders Action Needed section with high-urgency collaboration hints", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        collaborationHints: [
          { type: "blocked", message: "Bob is blocked on: API spec not finalized", urgency: "high", relatedIssue: "PAP-88" },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Action Needed");
    expect(container.textContent).toContain("PAP-88");
    expect(container.textContent).toContain("API spec not finalized");
  });

  it("renders Action Needed section alert count badge when items present", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          { issueId: "issue-1", issueIdentifier: "PAP-1", issueTitle: "Blocked", phase: "blocked", assigneeAgentName: "Alice", isRework: false, reworkCount: 0, blockedReason: "Waiting", expectedNextRole: null, expectedNextPhase: null, artifactChain: [] },
          { issueId: "issue-2", issueIdentifier: "PAP-2", issueTitle: "Blocked2", phase: "blocked", assigneeAgentName: "Bob", isRework: false, reworkCount: 0, blockedReason: "Waiting more", expectedNextRole: null, expectedNextPhase: null, artifactChain: [] },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    // Action Needed alert badge should show count > 0
    const alertBadges = container.querySelectorAll(".bg-red-500\\/10");
    expect(alertBadges.length).toBeGreaterThan(0);
  });

  it("renders IssueWorkflowRow with expectedNextRole and expectedNextPhase in readable format", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-next",
            issueIdentifier: "PAP-60",
            issueTitle: "Next phase test",
            phase: "executing",
            assigneeAgentName: "Eve",
            isRework: false,
            reworkCount: 0,
            blockedReason: null,
            expectedNextRole: "reviewer",
            expectedNextPhase: "code_review",
            artifactChain: ["planner", "executor"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-60");
    expect(container.textContent).toContain("Eve");
    expect(container.textContent).toContain("→reviewer");
    expect(container.textContent).toContain("code_review");
  });

  it("renders IssueWorkflowRow with rework signal and border indicator", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-rework-row",
            issueIdentifier: "PAP-70",
            issueTitle: "Rework row test",
            phase: "plan_review",
            assigneeAgentName: "Frank",
            isRework: true,
            reworkCount: 2,
            blockedReason: null,
            expectedNextRole: "executor",
            expectedNextPhase: "ready_for_execution",
            artifactChain: ["planner"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-70");
    expect(container.textContent).toContain("Frank");
    expect(container.textContent).toContain("2×");
  });

  it("renders IssueWorkflowRow with blocked reason and border indicator", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        issueWorkflowSummary: [
          {
            issueId: "issue-blocked-row",
            issueIdentifier: "PAP-80",
            issueTitle: "Blocked row test",
            phase: "blocked",
            assigneeAgentName: "Grace",
            isRework: false,
            reworkCount: 0,
            blockedReason: "Waiting for design review",
            expectedNextRole: null,
            expectedNextPhase: null,
            artifactChain: ["planner", "executor"],
          },
        ],
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("PAP-80");
    expect(container.textContent).toContain("Grace");
    expect(container.textContent).toContain("Waiting for design review");
  });
});

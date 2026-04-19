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
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createMockDigest(overrides: Partial<SwarmCockpitDigest> = {}): SwarmCockpitDigest {
  return {
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
    claimedPathsSummary: { byAgent: [] },
    recommendedAvoidPaths: { paths: [], reasons: [] },
    hotSlotUsage: { current: 0, max: 3 },
    queuedHotRunsCount: 0,
    ...overrides,
  };
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
      }),
    );

    renderWithProviders(<SwarmCockpit />, container);
    await flush();

    expect(container.textContent).toContain("Expired");
  });

  it("renders stuck runs with correct waiting time", async () => {
    mockSwarmDigestApi.getCockpitDigest.mockResolvedValueOnce(
      createMockDigest({
        runsStuck: [
          {
            id: "run-stuck-1",
            agentId: "agent-1",
            issueId: "issue-x",
            issueIdentifier: "PAP-5",
            issueTitle: "Stuck issue",
            status: "queued",
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
});

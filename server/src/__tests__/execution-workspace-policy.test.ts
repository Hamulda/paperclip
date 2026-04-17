import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceAdapterConfig,
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.ts";

describe("execution workspace policy helpers", () => {
  it("defaults new issue settings from enabled project policy", () => {
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "isolated_workspace",
      }),
    ).toEqual({ mode: "isolated_workspace" });
    expect(
      defaultIssueExecutionWorkspaceSettingsForProject({
        enabled: true,
        defaultMode: "shared_workspace",
      }),
    ).toEqual({ mode: "shared_workspace" });
    expect(defaultIssueExecutionWorkspaceSettingsForProject(null)).toBeNull();
  });

  it("prefers explicit issue mode over project policy and legacy overrides", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "shared_workspace" },
        issueSettings: { mode: "isolated_workspace" },
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
  });

  it("falls back to project policy before legacy project-workspace compatibility flag", () => {
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("isolated_workspace");
    expect(
      resolveExecutionWorkspaceMode({
        projectPolicy: null,
        issueSettings: null,
        legacyUseProjectWorkspace: false,
      }),
    ).toBe("agent_default");
  });

  it("applies project policy strategy and runtime defaults when isolation is enabled", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "project_primary" },
      },
      projectPolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/main",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });

    expect(result.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "origin/main",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("clears managed workspace strategy when issue opts out to project primary or agent default", () => {
    const baseConfig = {
      workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" },
      workspaceRuntime: { services: [{ name: "web" }] },
    };

    expect(
      buildExecutionWorkspaceAdapterConfig({
        agentConfig: baseConfig,
        projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
        issueSettings: { mode: "shared_workspace" },
        mode: "shared_workspace",
        legacyUseProjectWorkspace: null,
      }).workspaceStrategy,
    ).toBeUndefined();

    const agentDefault = buildExecutionWorkspaceAdapterConfig({
      agentConfig: baseConfig,
      projectPolicy: null,
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(agentDefault.workspaceStrategy).toBeUndefined();
    expect(agentDefault.workspaceRuntime).toBeUndefined();
  });

  it("parses persisted JSON payloads into typed project and issue workspace settings", () => {
    expect(
      parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "isolated",
        workspaceStrategy: {
          type: "git_worktree",
          worktreeParentDir: ".paperclip/worktrees",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          teardownCommand: "bash ./scripts/teardown-worktree.sh",
        },
      }),
    ).toEqual({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        worktreeParentDir: ".paperclip/worktrees",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
      },
    });
    expect(
      parseIssueExecutionWorkspaceSettings({
        mode: "project_primary",
      }),
    ).toEqual({
      mode: "shared_workspace",
    });
  });

  it("maps persisted execution workspace modes back to issue settings", () => {
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("isolated_workspace")).toBe("isolated_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("operator_branch")).toBe("operator_branch");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("shared_workspace")).toBe("shared_workspace");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("adapter_managed")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(null)).toBe("agent_default");
    expect(issueExecutionWorkspaceModeForPersistedWorkspace(undefined)).toBe("agent_default");
  });

  it("disables project execution workspace policy when the instance flag is off", () => {
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        false,
      ),
    ).toBeNull();
    expect(
      gateProjectExecutionWorkspacePolicy(
        { enabled: true, defaultMode: "isolated_workspace" },
        true,
      ),
    ).toEqual({ enabled: true, defaultMode: "isolated_workspace" });
  });

  it("parses project policy with workspaceRuntime services", () => {
    const parsed = parseProjectExecutionWorkspacePolicy({
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceRuntime: {
        services: [
          { name: "web", command: "pnpm dev", cwd: "/app" },
          { name: "api", command: "python -m http.server 8080" },
        ],
      },
    });
    expect(parsed.workspaceRuntime).toEqual({
      services: [
        { name: "web", command: "pnpm dev", cwd: "/app" },
        { name: "api", command: "python -m http.server 8080" },
      ],
    });
  });

  it("builds execution workspace adapter config with workspaceRuntime from project policy", () => {
    const projectPolicy = {
      enabled: true,
      defaultMode: "isolated_workspace",
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev" }],
      },
    };
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: { workspaceStrategy: { type: "project_primary" } },
      projectPolicy,
      issueSettings: null,
      mode: "isolated_workspace",
      legacyUseProjectWorkspace: null,
    });
    expect(result.workspaceRuntime).toEqual({
      services: [{ name: "web", command: "pnpm dev" }],
    });
  });

  it("clears workspaceRuntime when switching to agent_default", () => {
    const result = buildExecutionWorkspaceAdapterConfig({
      agentConfig: {
        workspaceStrategy: { type: "git_worktree" },
        workspaceRuntime: { services: [{ name: "web" }] },
      },
      projectPolicy: { enabled: true, defaultMode: "isolated_workspace" },
      issueSettings: { mode: "agent_default" },
      mode: "agent_default",
      legacyUseProjectWorkspace: null,
    });
    expect(result.workspaceRuntime).toBeUndefined();
  });
});

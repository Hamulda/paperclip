import { describe, expect, it } from "vitest";
import {
  buildExecutionWorkspaceConfigSnapshot,
  deriveRepoNameFromRepoUrl,
} from "../services/workspace-repo-utils.js";

describe("buildExecutionWorkspaceConfigSnapshot", () => {
  it("returns null for empty config", () => {
    expect(buildExecutionWorkspaceConfigSnapshot({})).toBeNull();
  });

  it("returns null when no workspace fields present", () => {
    expect(buildExecutionWorkspaceConfigSnapshot({ foo: "bar" })).toBeNull();
  });

  it("extracts provisionCommand and teardownCommand from workspaceStrategy", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceStrategy: {
        provisionCommand: "npm install",
        teardownCommand: "npm cleanup",
      },
    });
    expect(result).toEqual({
      provisionCommand: "npm install",
      teardownCommand: "npm cleanup",
    });
  });

  it("sets null for missing provisionCommand", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceStrategy: {
        teardownCommand: "npm cleanup",
      },
    });
    expect(result).toEqual({
      provisionCommand: null,
      teardownCommand: "npm cleanup",
    });
  });

  it("ignores non-string provisionCommand/teardownCommand and returns null when all null", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceStrategy: {
        provisionCommand: 123,
        teardownCommand: false,
      },
    });
    // Returns null since all values are null
    expect(result).toBeNull();
  });

  it("extracts workspaceRuntime when present (without workspaceStrategy)", () => {
    const runtime = { nodeVersion: "20", framework: "express" };
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceRuntime: runtime,
    });
    // Only workspaceRuntime is extracted since workspaceStrategy is not present
    expect(result).toEqual({
      workspaceRuntime: runtime,
    });
  });

  it("sets workspaceRuntime to null when empty object and returns null overall", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceRuntime: {},
    });
    // Since only workspaceRuntime is present and it's empty, the whole snapshot is null
    expect(result).toBeNull();
  });

  it("extracts both workspaceStrategy and workspaceRuntime", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceStrategy: { provisionCommand: "install" },
      workspaceRuntime: { nodeVersion: "20" },
    });
    expect(result).toEqual({
      provisionCommand: "install",
      teardownCommand: null,
      workspaceRuntime: { nodeVersion: "20" },
    });
  });

  it("returns null when only null values present", () => {
    const result = buildExecutionWorkspaceConfigSnapshot({
      workspaceStrategy: {},
      workspaceRuntime: {},
    });
    expect(result).toBeNull();
  });
});

describe("deriveRepoNameFromRepoUrl", () => {
  it("returns null for null input", () => {
    expect(deriveRepoNameFromRepoUrl(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(deriveRepoNameFromRepoUrl("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(deriveRepoNameFromRepoUrl("   ")).toBeNull();
  });

  it("extracts repo name from HTTPS URL", () => {
    expect(deriveRepoNameFromRepoUrl("https://github.com/user/my-repo")).toBe("my-repo");
  });

  it("returns null for SSH URL (not a valid URL format)", () => {
    // SSH URLs like git@github.com:user/my-repo.git are not valid standard URLs
    // and cannot be parsed by the URL constructor
    expect(deriveRepoNameFromRepoUrl("git@github.com:user/my-repo.git")).toBeNull();
  });

  it("removes .git suffix", () => {
    expect(deriveRepoNameFromRepoUrl("https://github.com/user/my-repo.git")).toBe("my-repo");
  });

  it("handles URL with trailing slashes", () => {
    expect(deriveRepoNameFromRepoUrl("https://github.com/user/my-repo///")).toBe("my-repo");
  });

  it("handles deep path URLs", () => {
    expect(deriveRepoNameFromRepoUrl("https://github.com/user/org/my-repo")).toBe("my-repo");
  });

  it("returns null for invalid URL", () => {
    expect(deriveRepoNameFromRepoUrl("not-a-url")).toBeNull();
  });

  it("handles URL with query params", () => {
    expect(deriveRepoNameFromRepoUrl("https://github.com/user/my-repo?ref=main")).toBe("my-repo");
  });

  it("trims whitespace", () => {
    expect(deriveRepoNameFromRepoUrl("  https://github.com/user/my-repo  ")).toBe("my-repo");
  });
});

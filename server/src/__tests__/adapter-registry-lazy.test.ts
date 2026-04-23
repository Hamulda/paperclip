import { describe, expect, it, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");

/**
 * Verifies true lazy import behavior for claude-only profile by spawning a
 * subprocess that loads the registry with PAPERCLIP_ADAPTER_PROFILE=claude-only.
 * This ensures no adapter packages are parsed/JITted until first use.
 */
describe("adapter registry lazy import (claude-only profile)", () => {
  describe("in 'all' profile (default)", () => {
    it("registers all built-in adapters eagerly", async () => {
      const { listServerAdapters } = await import("../adapters/index.js");
      const types = listServerAdapters().map((a) => a.type);
      expect(types).toContain("claude_local");
      expect(types).toContain("codex_local");
      expect(types).toContain("cursor");
      expect(types).toContain("gemini_local");
      expect(types).toContain("opencode_local");
      expect(types).toContain("pi_local");
      expect(types).toContain("openclaw_gateway");
      expect(types).toContain("hermes_local");
    });

    it("exposes listSkills for codex_local adapter", async () => {
      const { findActiveServerAdapter } = await import("../adapters/index.js");
      const codex = await findActiveServerAdapter("codex_local");
      expect(codex).not.toBeNull();
      expect(typeof codex!.listSkills).toBe("function");
      expect(typeof codex!.syncSkills).toBe("function");
    });
  });

  describe("in 'claude-only' profile", () => {
    const tmpFile = path.join(projectRoot, ".vitest-tmp-lazy-test.mjs");

    afterEach(() => {
      try { unlinkSync(tmpFile); } catch {}
    });

    function runInClaudeOnlyProfile(script: string): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const env = { ...process.env, PAPERCLIP_ADAPTER_PROFILE: "claude-only" };
        const tsxPath = path.join(projectRoot, "cli/node_modules/.bin/tsx");

        const fullScript = `(async () => {\n${script}\n})()`;
        writeFileSync(tmpFile, fullScript);

        const proc = spawn(
          tsxPath,
          [tmpFile],
          {
            cwd: projectRoot,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          try { unlinkSync(tmpFile); } catch {}
          if (code !== 0) {
            reject(new Error(`Subprocess exited ${code}: ${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error(`Failed to parse JSON: ${stdout}\nStderr: ${stderr}`));
          }
        });
      });
    }

    it("only registers always-on adapters before first use", async () => {
      const result = (await runInClaudeOnlyProfile(`
        const { listServerAdapters } = await import("./server/src/adapters/registry.js");
        process.stdout.write(JSON.stringify(listServerAdapters().map(a => a.type)));
      `)) as string[];

      // Only the always-on adapters should be present
      expect(result).toContain("claude_local");
      expect(result).toContain("process");
      expect(result).toContain("http");
      // Non-eager adapters must NOT be loaded yet
      expect(result).not.toContain("codex_local");
      expect(result).not.toContain("cursor");
      expect(result).not.toContain("gemini_local");
      expect(result).not.toContain("opencode_local");
      expect(result).not.toContain("pi_local");
      expect(result).not.toContain("openclaw_gateway");
      expect(result).not.toContain("hermes_local");
    });

    it("loads a non-eager adapter on first findActiveServerAdapter call", async () => {
      const result = (await runInClaudeOnlyProfile(`
        const { listServerAdapters, findActiveServerAdapter } = await import("./server/src/adapters/registry.js");
        const before = listServerAdapters().map(a => a.type);
        const adapter = await findActiveServerAdapter("codex_local");
        const after = listServerAdapters().map(a => a.type);
        process.stdout.write(JSON.stringify({
          before,
          after,
          adapterType: adapter?.type ?? null,
          hasListSkills: typeof adapter?.listSkills === "function",
        }));
      `)) as { before: string[]; after: string[]; adapterType: string | null; hasListSkills: boolean };

      expect(result.before).not.toContain("codex_local");
      expect(result.after).toContain("codex_local");
      expect(result.adapterType).toBe("codex_local");
      expect(result.hasListSkills).toBe(true);
    });

    it("does not load opencode_local until explicitly requested", async () => {
      const result = (await runInClaudeOnlyProfile(`
        const { listServerAdapters, findActiveServerAdapter } = await import("./server/src/adapters/registry.js");
        const before = listServerAdapters().map(a => a.type);
        // Load a different adapter first
        await findActiveServerAdapter("codex_local");
        const stillNoOpencode = listServerAdapters().map(a => a.type);
        process.stdout.write(JSON.stringify({ before, stillNoOpencode }));
      `)) as { before: string[]; stillNoOpencode: string[] };

      expect(result.before).not.toContain("opencode_local");
      expect(result.stillNoOpencode).not.toContain("opencode_local");
    });
  });
});

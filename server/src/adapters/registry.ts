import type { ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@paperclipai/adapter-gemini-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";

// ---------------------------------------------------------------------------
// Adapter runtime profile — reduces startup overhead on resource-constrained
// hardware (e.g. MacBook Air M1 8 GB). In "claude-only" mode only the Claude
// Code adapter + process/http built-ins are registered eagerly; all other
// adapters are loaded lazily on first use via dynamic import.
// ---------------------------------------------------------------------------

type AdapterProfile = "all" | "claude-only";

function getAdapterProfile(): AdapterProfile {
  const env = process.env.PAPERCLIP_ADAPTER_PROFILE;
  if (env === "claude-only") return "claude-only";
  return "all";
}

const ADAPTER_PROFILE = getAdapterProfile();

// ---------------------------------------------------------------------------
// Lazy adapter loading — for non-eager adapters in claude-only profile
// ---------------------------------------------------------------------------

interface LazyAdapterEntry {
  module: ServerAdapterModule;
  loadPromise: Promise<ServerAdapterModule>;
}

const lazyAdapters = new Map<string, LazyAdapterEntry>();

// ---------------------------------------------------------------------------
// Built-in adapter definitions
// ---------------------------------------------------------------------------

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: hermesExecute,
  testEnvironment: hermesTestEnvironment,
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

// Map of type → lazy loader (used only in claude-only profile)
const LAZY_LOADER_FNS: Record<string, () => Promise<ServerAdapterModule>> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = Record<string, any>;

function buildLazyLoaders(): void {
  // TRUE lazy load via dynamic import() — no adapter package is imported/parsed/JITted
  // until first use in claude-only profile. In "all" profile this block is skipped
  // and adapters are registered via registerAllAdaptersForAllProfile() instead.
  if (ADAPTER_PROFILE !== "claude-only") return;

  LAZY_LOADER_FNS["codex_local"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-codex-local/server"),
      import("@paperclipai/adapter-codex-local"),
    ]) as [AnyModule, AnyModule];
    const { listCodexModels } = await import("./codex-models.js") as { listCodexModels: AnyModule };
    return {
      type: "codex_local", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listSkills, syncSkills: server.syncSkills,
      sessionCodec: server.sessionCodec,
      sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
      models: models.models, listModels: listCodexModels,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: false,
      agentConfigurationDoc: models.agentConfigurationDoc, getQuotaWindows: server.getQuotaWindows,
    } as ServerAdapterModule;
  };

  LAZY_LOADER_FNS["cursor"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-cursor-local/server"),
      import("@paperclipai/adapter-cursor-local"),
    ]) as [AnyModule, AnyModule];
    const { listCursorModels } = await import("./cursor-models.js") as { listCursorModels: AnyModule };
    return {
      type: "cursor", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listSkills, syncSkills: server.syncSkills,
      sessionCodec: server.sessionCodec,
      sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
      models: models.models, listModels: listCursorModels,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: true,
      agentConfigurationDoc: models.agentConfigurationDoc,
    } as ServerAdapterModule;
  };

  LAZY_LOADER_FNS["gemini_local"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-gemini-local/server"),
      import("@paperclipai/adapter-gemini-local"),
    ]) as [AnyModule, AnyModule];
    return {
      type: "gemini_local", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listSkills, syncSkills: server.syncSkills,
      sessionCodec: server.sessionCodec,
      sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
      models: models.models,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: true,
      agentConfigurationDoc: models.agentConfigurationDoc,
    } as ServerAdapterModule;
  };

  LAZY_LOADER_FNS["opencode_local"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-opencode-local/server"),
      import("@paperclipai/adapter-opencode-local"),
    ]) as [AnyModule, AnyModule];
    return {
      type: "opencode_local", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listSkills, syncSkills: server.syncSkills,
      sessionCodec: server.sessionCodec, models: models.models, listModels: server.listModels,
      sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: true,
      agentConfigurationDoc: models.agentConfigurationDoc,
    } as ServerAdapterModule;
  };

  LAZY_LOADER_FNS["pi_local"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-pi-local/server"),
      import("@paperclipai/adapter-pi-local"),
    ]) as [AnyModule, AnyModule];
    return {
      type: "pi_local", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listSkills, syncSkills: server.syncSkills,
      sessionCodec: server.sessionCodec,
      sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
      models: [], listModels: server.listModels,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: true,
      agentConfigurationDoc: models.agentConfigurationDoc,
    } as ServerAdapterModule;
  };

  LAZY_LOADER_FNS["openclaw_gateway"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-openclaw-gateway/server"),
      import("@paperclipai/adapter-openclaw-gateway"),
    ]) as [AnyModule, AnyModule];
    return {
      type: "openclaw_gateway", execute: server.execute, testEnvironment: server.testEnvironment,
      models: models.models,
      supportsLocalAgentJwt: false, supportsInstructionsBundle: false,
      requiresMaterializedRuntimeSkills: false, agentConfigurationDoc: models.agentConfigurationDoc,
    };
  };

  LAZY_LOADER_FNS["hermes_local"] = async () => {
    const [server, models] = await Promise.all([
      import("hermes-paperclip-adapter/server"),
      import("hermes-paperclip-adapter"),
    ]) as [AnyModule, AnyModule];
    return {
      type: "hermes_local", execute: server.execute, testEnvironment: server.testEnvironment,
      sessionCodec: server.sessionCodec, listSkills: server.listSkills, syncSkills: server.syncSkills,
      models: models.models,
      supportsLocalAgentJwt: true, supportsInstructionsBundle: true,
      instructionsPathKey: "instructionsFilePath", requiresMaterializedRuntimeSkills: false,
      agentConfigurationDoc: models.agentConfigurationDoc, detectModel: server.detectModel,
    } as ServerAdapterModule;
  };
}

buildLazyLoaders();

// ---------------------------------------------------------------------------
// Adapter registry maps
// ---------------------------------------------------------------------------

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

// ---------------------------------------------------------------------------
// Trigger lazy load of an adapter if not yet loaded (claude-only profile)
// ---------------------------------------------------------------------------

function ensureLazyAdapterLoaded(type: string): void {
  if (lazyAdapters.has(type)) return;
  const loader = LAZY_LOADER_FNS[type];
  if (!loader) return;
  const loadPromise = loader().then((module) => {
    lazyAdapters.set(type, { module, loadPromise });
    adaptersByType.set(type, module);
    return module;
  });
  lazyAdapters.set(type, { module: loadPromise as unknown as ServerAdapterModule, loadPromise });
}

// ---------------------------------------------------------------------------
// Register built-in adapters
//
// - "all" profile: ALL adapters are synchronously registered at module load
// - "claude-only" profile: only claude_local + process + http are registered.
//   Other adapters are loaded lazily on first use via findActiveServerAdapter.
// ---------------------------------------------------------------------------

function registerBuiltInAdapters(): void {
  // Always-on adapters: claude_local + process + http
  adaptersByType.set(claudeLocalAdapter.type, claudeLocalAdapter);
  adaptersByType.set(processAdapter.type, processAdapter);
  adaptersByType.set(httpAdapter.type, httpAdapter);

  if (ADAPTER_PROFILE === "all") {
    // In "all" profile, register all other adapters immediately (same as original)
    adaptersByType.set(codexLocalAdapter.type, codexLocalAdapter);
    adaptersByType.set(cursorLocalAdapter.type, cursorLocalAdapter);
    adaptersByType.set(geminiLocalAdapter.type, geminiLocalAdapter);
    adaptersByType.set(openclawGatewayAdapter.type, openclawGatewayAdapter);
    adaptersByType.set(openCodeLocalAdapter.type, openCodeLocalAdapter);
    adaptersByType.set(piLocalAdapter.type, piLocalAdapter);
    adaptersByType.set(hermesLocalAdapter.type, hermesLocalAdapter);
  }
  // In "claude-only" profile, other adapters remain unloaded until first use
}

registerBuiltInAdapters();

export function waitForBuiltInAdapters(): Promise<void> {
  // In "all" profile, adapters are already registered synchronously
  // In "claude-only" profile, only the always-on adapters are registered
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Cached sync wrapper — the store is a simple JSON file read, safe to call frequently.
// ---------------------------------------------------------------------------

function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
// ---------------------------------------------------------------------------

const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        {
          ...externalAdapter,
          sessionManagement: getAdapterSessionManagement(externalAdapter.type) ?? undefined,
        },
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
  lazyAdapters.delete(adapter.type);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
  lazyAdapters.delete(type);
}

export async function requireServerAdapter(type: string): Promise<ServerAdapterModule> {
  const adapter = await findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return adaptersByType.get(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = await findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = await findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export async function findActiveServerAdapter(type: string): Promise<ServerAdapterModule | null> {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }

  const found = adaptersByType.get(type);
  if (found) return found;

  // In "claude-only" profile, non-eager adapters are loaded lazily on first use
  if (ADAPTER_PROFILE === "claude-only" && LAZY_LOADER_FNS[type]) {
    if (!lazyAdapters.has(type)) {
      ensureLazyAdapterLoaded(type);
    }
    const entry = lazyAdapters.get(type);
    if (entry) {
      await entry.loadPromise;
    }
    return adaptersByType.get(type) ?? null;
  }

  return null;
}

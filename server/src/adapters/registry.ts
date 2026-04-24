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
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes, listAdapterPlugins } from "../services/adapter-plugin-store.js";

// ---------------------------------------------------------------------------
// Adapter runtime profile — reduces startup overhead on resource-constrained
// hardware (e.g. MacBook Air M1 8 GB). In "claude-only" mode only the Claude
// Code adapter + process/http built-ins are registered eagerly; all other
// adapters are loaded lazily on first use via dynamic import().
// ---------------------------------------------------------------------------

type AdapterProfile = "all" | "claude-only";

function getAdapterProfile(): AdapterProfile {
  const env = process.env.PAPERCLIP_ADAPTER_PROFILE;
  if (env === "claude-only") return "claude-only";
  return "all";
}

const ADAPTER_PROFILE = getAdapterProfile();

// ---------------------------------------------------------------------------
// Lazy adapter loading — non-claude adapters use dynamic import() so their
// packages are never parsed/JITted unless actually used (claude-only profile)
// or until registered at startup (all profile).
// ---------------------------------------------------------------------------

interface LazyAdapterEntry {
  module: ServerAdapterModule;
  loadPromise: Promise<ServerAdapterModule>;
}

const lazyAdapters = new Map<string, LazyAdapterEntry>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModule = Record<string, any>;

// ---------------------------------------------------------------------------
// Built-in adapter definitions — always-on adapters loaded eagerly
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

// ---------------------------------------------------------------------------
// Map of type → lazy loader — used by both profiles (all: called at startup,
// claude-only: called on first use)
// ---------------------------------------------------------------------------

const LAZY_LOADER_FNS: Record<string, () => Promise<ServerAdapterModule>> = {};

function buildLazyLoaders(): void {
  // LAZY_LOADER_FNS is populated in BOTH profiles:
  // - "all" profile: loaders are called at startup in registerBuiltInAdapters()
  // - "claude-only" profile: loaders are called on-demand in findActiveServerAdapter()
  // The early return below only prevented population — we now build in both modes
  // so findActiveServerAdapter can trigger on-demand loading in claude-only mode.

  LAZY_LOADER_FNS["codex_local"] = async () => {
    const [server, models] = await Promise.all([
      import("@paperclipai/adapter-codex-local/server"),
      import("@paperclipai/adapter-codex-local"),
    ]) as [AnyModule, AnyModule];
    const { listCodexModels } = await import("./codex-models.js") as { listCodexModels: AnyModule };
    return {
      type: "codex_local", execute: server.execute, testEnvironment: server.testEnvironment,
      listSkills: server.listCodexSkills, syncSkills: server.syncCodexSkills,
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
      listSkills: server.listCursorSkills, syncSkills: server.syncCursorSkills,
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
      listSkills: server.listGeminiSkills, syncSkills: server.syncGeminiSkills,
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
      listSkills: server.listOpenCodeSkills, syncSkills: server.syncOpenCodeSkills,
      sessionCodec: server.sessionCodec, models: models.models, listModels: server.listOpenCodeModels,
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
      listSkills: server.listPiSkills, syncSkills: server.syncPiSkills,
      sessionCodec: server.sessionCodec,
      sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
      models: [], listModels: server.listPiModels,
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
// - "all" profile: ALL adapters are registered at module load via dynamic
//   import (packages are imported at startup, same as original static import)
// - "claude-only" profile: only claude_local + process + http are registered.
//   Other adapters are loaded lazily on first use via findActiveServerAdapter.
// ---------------------------------------------------------------------------

async function registerBuiltInAdapters(): Promise<void> {
  // Always-on adapters: claude_local + process + http
  adaptersByType.set(claudeLocalAdapter.type, claudeLocalAdapter);
  adaptersByType.set(processAdapter.type, processAdapter);
  adaptersByType.set(httpAdapter.type, httpAdapter);

  if (ADAPTER_PROFILE === "all") {
    // In "all" profile, register all other adapters via their lazy loaders.
    // The dynamic import() inside each loader runs now (at startup), making
    // adapters available synchronously after this function resolves.
    for (const type of Object.keys(LAZY_LOADER_FNS)) {
      const loader = LAZY_LOADER_FNS[type]!;
      const module = await loader();
      adaptersByType.set(type, module);
    }
  }
  // In "claude-only" profile, other adapters remain unloaded until first use
}

await registerBuiltInAdapters();

export function waitForBuiltInAdapters(): Promise<void> {
  // In "all" profile, adapters are already registered (awaited above)
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

/**
 * List adapter types currently registered and loaded in the runtime registry.
 * In "claude-only" profile this only includes the 3 always-on adapters
 * (claude_local, process, http) until a specific adapter is first accessed
 * via findActiveServerAdapter(), which triggers lazy loading.
 */
export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * Metadata-only catalog of all known adapter types — does NOT trigger lazy
 * loading. Returns builtin types from BUILTIN_ADAPTER_TYPES plus any
 * externally registered plugin types from the adapter-plugin store.
 *
 * Use this when you need to enumerate or display the full adapter catalog
 * without caring about which ones are currently loaded in the runtime.
 */
export function listKnownServerAdapterTypes(): string[] {
  const builtinTypes = Array.from(BUILTIN_ADAPTER_TYPES);
  const externalTypes = listAdapterPlugins().map((p) => p.type);
  return [...builtinTypes, ...externalTypes];
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

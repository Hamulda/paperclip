import type { Db } from "@paperclipai/db";
import { and, asc, eq } from "drizzle-orm";
import type {
  ExecutionWorkspace,
} from "@paperclipai/shared";
import {
  issues,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  realizeExecutionWorkspace,
} from "./workspace-runtime.js";
import { executionWorkspaceService, mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import {
  applyPersistedExecutionWorkspaceConfig,
  buildRealizedExecutionWorkspaceFromPersisted,
  resolveRuntimeSessionParamsForWorkspace,
  resolveExecutionRunAdapterConfig,
  resolveRunScopedMentionedSkillKeys,
  applyRunScopedMentionedSkillKeys,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  type ResolvedWorkspaceForRun,
} from "./runtime-config-builder.js";
import { buildExecutionWorkspaceConfigSnapshot } from "./workspace-repo-utils.js";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";
import { parseObject } from "../adapters/utils.js";

// Re-export for consumers who need the result shape
export type { ExecutionWorkspace } from "@paperclipai/shared";
export type { ResolvedWorkspaceForRun, RealizedExecutionWorkspace } from "./runtime-config-builder.js";

// ─── Input/Output types ────────────────────────────────────────────────────────

export interface IssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
}

export interface PersistedExecutionWorkspaceInput {
  issueRef: IssueRef | null;
  requestedExecutionWorkspaceMode: string;
  issueExecutionWorkspaceSettings: unknown | null;
  projectExecutionWorkspacePolicy: unknown | null;
  issueAssigneeOverrides: { adapterConfig?: Record<string, unknown> | null; useProjectWorkspace?: boolean | null } | null;
  agentAdapterConfig: Record<string, unknown>;
  projectContext: { env?: Record<string, string> | null } | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
  executionProjectId: string | null;
  runId: string;
  agentCompanyId: string;
  agentId: string;
  agentName: string;
  issueId: string | null;
  db: Db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executionWorkspacesSvc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  issuesSvc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  secretsSvc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  companySkills: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workspaceOperationsSvc: any;
}

export interface PersistedExecutionWorkspaceResult {
  persistedExecutionWorkspace: ExecutionWorkspace | null;
  executionWorkspace: ReturnType<typeof realizeExecutionWorkspace> extends Promise<infer T> ? T : never;
  runtimeConfig: Record<string, unknown>;
  configSnapshot: ReturnType<typeof buildExecutionWorkspaceConfigSnapshot> | null;
  resolvedConfig: Record<string, unknown>;
  secretKeys: string[];
  effectiveExecutionWorkspaceMode: string;
  resolvedProjectId: string | null;
  resolvedProjectWorkspaceId: string | null;
  runtimeSessionResolution: ReturnType<typeof resolveRuntimeSessionParamsForWorkspace>;
  workspaceWarnings: string[];
}

export async function persistExecutionWorkspaceForRun({
  issueRef,
  requestedExecutionWorkspaceMode,
  issueExecutionWorkspaceSettings,
  projectExecutionWorkspacePolicy,
  issueAssigneeOverrides,
  agentAdapterConfig,
  projectContext,
  resolvedWorkspace,
  executionProjectId,
  runId,
  agentCompanyId,
  agentId,
  agentName,
  issueId,
  db,
  executionWorkspacesSvc,
  issuesSvc,
  secretsSvc,
  companySkills,
  workspaceOperationsSvc,
}: PersistedExecutionWorkspaceInput): Promise<PersistedExecutionWorkspaceResult> {
  const config = agentAdapterConfig;
  const issueExecWsSettings = parseIssueExecutionWorkspaceSettings(issueExecutionWorkspaceSettings);
  const projectWsPolicy = parseProjectExecutionWorkspacePolicy(projectExecutionWorkspacePolicy);
  const existingExecutionWorkspace =
    issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
  const shouldReuseExisting =
    issueRef?.executionWorkspacePreference === "reuse_existing" &&
    existingExecutionWorkspace &&
    existingExecutionWorkspace.status !== "archived";
  const persistedExecutionWorkspaceMode = shouldReuseExisting && existingExecutionWorkspace
    ? issueExecutionWorkspaceModeForPersistedWorkspace(existingExecutionWorkspace.mode)
    : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const effectiveExecutionWorkspaceMode: any =
    persistedExecutionWorkspaceMode === "isolated_workspace" ||
    persistedExecutionWorkspaceMode === "operator_branch" ||
    persistedExecutionWorkspaceMode === "agent_default"
      ? persistedExecutionWorkspaceMode
      : requestedExecutionWorkspaceMode;
  const workspaceManagedConfig = shouldReuseExisting
    ? { ...config }
    : buildExecutionWorkspaceAdapterConfig({
        agentConfig: config,
        projectPolicy: projectWsPolicy,
        issueSettings: issueExecWsSettings,
        mode: effectiveExecutionWorkspaceMode,
        legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
      });
  const persistedWorkspaceManagedConfig = applyPersistedExecutionWorkspaceConfig({
    config: workspaceManagedConfig,
    workspaceConfig: existingExecutionWorkspace?.config ?? null,
    mode: effectiveExecutionWorkspaceMode,
  });
  const mergedConfig = issueAssigneeOverrides?.adapterConfig
    ? { ...persistedWorkspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
    : persistedWorkspaceManagedConfig;
  const configSnapshot = buildExecutionWorkspaceConfigSnapshot(mergedConfig);
  const workspaceRuntimeForServices = mergedConfig.workspaceRuntime as Record<string, unknown> | undefined;
  const executionRunConfig = stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
  const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
    companyId: agentCompanyId,
    executionRunConfig,
    projectEnv: projectContext?.env ?? null,
    secretsSvc,
  });
  const runScopedMentionedSkillKeys = await resolveRunScopedMentionedSkillKeys({
    db,
    companyId: agentCompanyId,
    issueId,
  });
  const effectiveResolvedConfig = applyRunScopedMentionedSkillKeys(
    resolvedConfig,
    runScopedMentionedSkillKeys,
  );
  const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agentCompanyId);
  const runtimeConfig = {
    ...effectiveResolvedConfig,
    paperclipRuntimeSkills: runtimeSkillEntries,
    ...(workspaceRuntimeForServices ? { workspaceRuntime: workspaceRuntimeForServices } : {}),
  };
  const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
    companyId: agentCompanyId,
    heartbeatRunId: runId,
    executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
  });
  const executionWorkspaceBase = {
    baseCwd: resolvedWorkspace.cwd,
    source: resolvedWorkspace.source,
    projectId: resolvedWorkspace.projectId,
    workspaceId: resolvedWorkspace.workspaceId,
    repoUrl: resolvedWorkspace.repoUrl,
    repoRef: resolvedWorkspace.repoRef,
  };
  const reusedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
    ? buildRealizedExecutionWorkspaceFromPersisted({
        base: executionWorkspaceBase,
        workspace: existingExecutionWorkspace,
      })
    : null;
  const executionWorkspace = reusedExecutionWorkspace ?? await realizeExecutionWorkspace({
      base: executionWorkspaceBase,
      config: runtimeConfig,
      issue: issueRef ?? null,
      agent: {
        id: agentId,
        name: agentName,
        companyId: agentCompanyId,
      },
      recorder: workspaceOperationRecorder,
    });
  const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
  const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
  let persistedExecutionWorkspace = null;
  const nextExecutionWorkspaceMetadataBase = {
    ...(existingExecutionWorkspace?.metadata ?? {}),
    source: executionWorkspace.source,
    createdByRuntime: executionWorkspace.created,
  } as Record<string, unknown>;
  const nextExecutionWorkspaceMetadata = shouldReuseExisting
    ? nextExecutionWorkspaceMetadataBase
    : configSnapshot
      ? mergeExecutionWorkspaceConfig(nextExecutionWorkspaceMetadataBase, configSnapshot)
      : nextExecutionWorkspaceMetadataBase;
  try {
    persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
          cwd: executionWorkspace.cwd,
          repoUrl: executionWorkspace.repoUrl,
          baseRef: executionWorkspace.repoRef,
          branchName: executionWorkspace.branchName,
          providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
          providerRef: executionWorkspace.worktreePath,
          status: "active",
          lastUsedAt: new Date(),
          metadata: nextExecutionWorkspaceMetadata,
        })
      : resolvedProjectId
        ? await executionWorkspacesSvc.create({
            companyId: agentCompanyId,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            mode:
              requestedExecutionWorkspaceMode === "isolated_workspace"
                ? "isolated_workspace"
                : requestedExecutionWorkspaceMode === "operator_branch"
                  ? "operator_branch"
                  : requestedExecutionWorkspaceMode === "agent_default"
                    ? "adapter_managed"
                    : "shared_workspace",
            strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
            name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agentId.slice(0, 8)}`,
            status: "active",
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            lastUsedAt: new Date(),
            openedAt: new Date(),
            metadata: nextExecutionWorkspaceMetadata,
          })
        : null;
  } catch (error) {
    if (executionWorkspace.created) {
      try {
        await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            id: existingExecutionWorkspace?.id ?? `transient-${runId}`,
            cwd: executionWorkspace.cwd,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            branchName: executionWorkspace.branchName,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            metadata: {
              createdByRuntime: true,
              source: executionWorkspace.source,
            },
          },
          projectWorkspace: {
            cwd: resolvedWorkspace.cwd,
            cleanupCommand: null,
          },
          cleanupCommand: configSnapshot?.cleanupCommand ?? null,
          teardownCommand: configSnapshot?.teardownCommand ?? null,
          recorder: workspaceOperationRecorder,
        });
      } catch (cleanupError) {
        logger.warn(
          {
            runId,
            issueId,
            executionWorkspaceCwd: executionWorkspace.cwd,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup realized execution workspace after persistence failure",
        );
      }
    }
    throw error;
  }
  await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
  if (
    existingExecutionWorkspace &&
    persistedExecutionWorkspace &&
    existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
    existingExecutionWorkspace.status === "active"
  ) {
    await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
      status: "idle",
      cleanupReason: null,
    });
  }
  if (issueId && persistedExecutionWorkspace) {
    const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
    const shouldSwitchIssueToExistingWorkspace =
      issueRef?.executionWorkspacePreference === "reuse_existing" ||
      requestedExecutionWorkspaceMode === "isolated_workspace" ||
      requestedExecutionWorkspaceMode === "operator_branch";
    const nextIssuePatch: Record<string, unknown> = {};
    if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
    }
    if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
      nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
    }
    if (shouldSwitchIssueToExistingWorkspace) {
      nextIssuePatch.executionWorkspacePreference = "reuse_existing";
      nextIssuePatch.executionWorkspaceSettings = {
        ...((issueExecutionWorkspaceSettings as Record<string, unknown>) ?? {}),
        mode: nextIssueWorkspaceMode,
      };
    }
    if (Object.keys(nextIssuePatch).length > 0) {
      await issuesSvc.update(issueId, nextIssuePatch);
    }
  }
  const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
    agentId,
    previousSessionParams: null,
    resolvedWorkspace: {
      ...resolvedWorkspace,
      cwd: executionWorkspace.cwd,
    },
  });
  const workspaceWarnings = [
    ...resolvedWorkspace.warnings,
    ...executionWorkspace.warnings,
    ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
  ];
  return {
    persistedExecutionWorkspace,
    executionWorkspace,
    runtimeConfig,
    configSnapshot,
    resolvedConfig,
    secretKeys: Array.isArray(secretKeys) ? secretKeys : Array.from(secretKeys),
    effectiveExecutionWorkspaceMode,
    resolvedProjectId,
    resolvedProjectWorkspaceId,
    runtimeSessionResolution,
    workspaceWarnings,
  };
}

// ─── Re-export helpers needed by the caller ──────────────────────────────────

export { resolveRunScopedMentionedSkillKeys, applyRunScopedMentionedSkillKeys } from "./runtime-config-builder.js";

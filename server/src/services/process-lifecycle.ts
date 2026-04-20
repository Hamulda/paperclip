// =============================================================================
// Process Lifecycle — Process liveness detection and termination utilities
// =============================================================================

import { terminateLocalService } from "./local-service-supervisor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DETACHED_PROCESS_ERROR_CODE = "process_detached";

// ---------------------------------------------------------------------------
// Process liveness check
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Process termination
// ---------------------------------------------------------------------------

export async function terminateHeartbeatRunProcess(input: {
  pid: number | null | undefined;
  processGroupId: number | null | undefined;
  graceMs?: number;
}) {
  const pid = input.pid ?? null;
  const processGroupId = input.processGroupId ?? null;
  if (typeof pid !== "number" && typeof processGroupId !== "number") return;

  await terminateLocalService(
    {
      pid:
        typeof pid === "number" && Number.isInteger(pid) && pid > 0
          ? pid
          : (processGroupId ?? 0),
      processGroupId:
        typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
          ? processGroupId
          : null,
    },
    input.graceMs ? { forceAfterMs: input.graceMs } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Process loss message builder
// ---------------------------------------------------------------------------

export function buildProcessLossMessage(
  run: {
    processPid: number | null;
    processGroupId: number | null;
  },
  options?: { descendantOnly?: boolean },
) {
  if (options?.descendantOnly && run.processGroupId) {
    return `Process lost -- parent pid ${run.processPid ?? "unknown"} exited, but descendant process group ${run.processGroupId} was still alive and was terminated`;
  }
  if (run.processPid) {
    return `Process lost -- child pid ${run.processPid} is no longer running`;
  }
  if (run.processGroupId) {
    return `Process lost -- process group ${run.processGroupId} is no longer running`;
  }
  return "Process lost -- server may have restarted";
}

// ---------------------------------------------------------------------------
// Constants export for reuse
// ---------------------------------------------------------------------------

export { DETACHED_PROCESS_ERROR_CODE };

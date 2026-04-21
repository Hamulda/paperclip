import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { swarmDigestApi, type SwarmCockpitDigest } from "@/api/swarm-digest";
import { PageSkeleton } from "@/components/PageSkeleton";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { useSearchParams, useNavigate } from "@/lib/router";
import type { IssuePhase } from "@paperclipai/shared";
import { ISSUE_PHASE_LABELS } from "@paperclipai/shared";
import {
  Bot,
  CircleDot,
  Folder,
  AlertTriangle,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowRight,
  FileText,
  AlertCircle,
  MapPin,
  Shield,
  Scale,
  Ban,
  Lightbulb,
  Star,
  ClipboardCheck,
  MessageSquare,
  Repeat,
  UserCheck,
  ChevronRight,
} from "lucide-react";

function SummaryStrip({ data, isFetching }: { data: SwarmCockpitDigest; isFetching: boolean }) {
  const reviewNeededCount = data.reviewQueue?.readyForReview?.length ?? 0;
  const alerts = [
    { count: data.fileClaimConflicts.length, label: "conflicts", urgent: true, href: "#conflicts" },
    { count: data.runsStuck.length, label: "stuck", urgent: true, href: "#stuck-runs" },
    { count: data.servicesDegraded.length, label: "degraded", urgent: true, href: "#degraded-services" },
    { count: data.fileClaimStale.filter(c => c.minutesUntilExpiry <= 0).length, label: "expired", urgent: true, href: "#stale-claims" },
    { count: reviewNeededCount, label: "review needed", urgent: true, href: "#review-queue" },
    { count: data.fileClaimStale.filter(c => c.minutesUntilExpiry === 1).length, label: "expiring soon", urgent: false, href: "#stale-claims" },
    { count: data.activeRuns.length, label: "active runs", urgent: false, href: "#active-runs" },
    { count: data.activeAgents.length, label: "agents", urgent: false, href: "#active-agents" },
  ].filter(a => a.count > 0);

  return (
    <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border/50 px-1 py-2">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground font-medium shrink-0 text-sm">Swarm</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {alerts.map(alert => (
            <a
              key={alert.label}
              href={alert.href}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium transition-colors text-xs no-underline hover:underline",
                alert.urgent
                  ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
              )}
            >
              <span className="font-mono">{alert.count}</span>
              <span> </span>
              <span>{alert.label}</span>
            </a>
          ))}
          {alerts.length === 0 && (
            <span className="text-green-600 dark:text-green-400 font-medium text-sm">All clear</span>
          )}
        </div>
        <div className="ml-auto shrink-0 text-xs text-muted-foreground flex items-center gap-2">
          {isFetching && <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />}
          <span>{data.activeAgents.length} agents · {data.activeRuns.length} runs</span>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  children,
  className,
  alertCount,
  id,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
  alertCount?: number;
  id?: string;
}) {
  return (
    <div id={id} className={cn("rounded-lg border bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {title}
        </h3>
        {alertCount !== undefined && alertCount > 0 && (
          <span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500/10 text-xs font-mono font-medium text-red-600 dark:text-red-400">
            {alertCount}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string | null | undefined }) {
  if (!phase) return null;
  const labels: Partial<Record<string, string>> = ISSUE_PHASE_LABELS;
  const label = (labels as Record<string, string>)[phase] ?? phase;
  const colors: Record<string, string> = {
    triage: "text-purple-500 bg-purple-500/10",
    planning: "text-blue-500 bg-blue-500/10",
    plan_review: "text-violet-500 bg-violet-500/10",
    ready_for_execution: "text-cyan-500 bg-cyan-500/10",
    executing: "text-green-500 bg-green-500/10",
    code_review: "text-amber-500 bg-amber-500/10",
    integration: "text-orange-500 bg-orange-500/10",
    done: "text-green-600 bg-green-500/10",
    blocked: "text-red-500 bg-red-500/10",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium shrink-0", colors[phase] ?? "text-muted bg-muted/50")}>
      {label}
    </span>
  );
}

function ReviewSignalBadge({ verificationStatus, mergeReadiness }: { verificationStatus: string | null; mergeReadiness: string | null }) {
  if (!verificationStatus && !mergeReadiness) return null;
  if (verificationStatus === "verified" || mergeReadiness === "ready") {
    return <span className="text-xs text-green-600 font-medium shrink-0">✓ merge ready</span>;
  }
  if (verificationStatus === "blocked" || mergeReadiness === "blocked") {
    return <span className="text-xs text-red-500 font-medium shrink-0">✗ blocked</span>;
  }
  if (verificationStatus === "needs_verification" || mergeReadiness === "conditional") {
    return <span className="text-xs text-amber-500 font-medium shrink-0">~ rework</span>;
  }
  return null;
}

function BlockedBadge({ blockers }: { blockers: string[] }) {
  if (!blockers.length) return null;
  return (
    <span className="text-xs text-red-500 font-medium shrink-0" title={blockers.join("; ")}>
      ⚠ blocked
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { icon: React.ComponentType<{ className?: string }>; className: string }> = {
    running: { icon: CircleDot, className: "text-green-500 bg-green-500/10" },
    queued: { icon: Clock, className: "text-yellow-500 bg-yellow-500/10" },
    starting: { icon: Zap, className: "text-blue-500 bg-blue-500/10" },
    active: { icon: CheckCircle2, className: "text-green-500 bg-green-500/10" },
    failed: { icon: XCircle, className: "text-red-500 bg-red-500/10" },
    error: { icon: XCircle, className: "text-red-500 bg-red-500/10" },
  };
  const config = configs[status] ?? { icon: CircleDot, className: "text-muted bg-muted/50" };
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", config.className)}>
      <Icon className="h-3 w-3" />
      {status}
    </span>
  );
}

function HotSlotMeter({ current, max }: { current: number; max: number }) {
  const percentage = Math.min((current / max) * 100, 100);
  const isHigh = percentage >= 75;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Hot slots</span>
        <span className={cn("font-mono", isHigh ? "text-red-500" : "text-foreground")}>
          {current}/{max}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", isHigh ? "bg-red-500" : "bg-blue-500")}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function AgentRow({ agent }: { agent: { id: string; name: string; status: string; role: string | null } }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{agent.name}</span>
        {agent.role && (
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {agent.role}
          </span>
        )}
      </div>
      <StatusBadge status={agent.status} />
    </div>
  );
}

function RunRow({ run }: { run: { id: string; agentId: string; issueIdentifier: string | null; issueTitle: string | null; status: string; startedAt: string | null; swarmRole: string | null; phase?: string | null; blockers?: string[]; verificationStatus?: string | null; mergeReadiness?: string | null; ownerAgentName?: string | null } }) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-center justify-between py-2 text-sm cursor-pointer hover:bg-muted/50 -mx-2 px-2 rounded transition-colors"
      onClick={() => run.issueIdentifier && navigate(`/issues/${run.issueIdentifier}`)}
      role={run.issueIdentifier ? "button" : undefined}
      tabIndex={run.issueIdentifier ? 0 : undefined}
      onKeyDown={(e) => { if (run.issueIdentifier && e.key === "Enter") navigate(`/issues/${run.issueIdentifier}`); }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {run.issueIdentifier ? (
            <span className="text-blue-600 dark:text-blue-400 font-medium hover:underline">{run.issueIdentifier}</span>
          ) : (
            <span className="text-muted-foreground">No issue</span>
          )}
          <span className="truncate text-muted-foreground">{run.issueTitle ?? ""}</span>
          <PhaseBadge phase={run.phase} />
          {run.swarmRole && (
            <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded shrink-0">
              {run.swarmRole}
            </span>
          )}
          {run.ownerAgentName && (
            <span className="text-xs text-muted-foreground shrink-0">{run.ownerAgentName}</span>
          )}
          <ReviewSignalBadge verificationStatus={run.verificationStatus ?? null} mergeReadiness={run.mergeReadiness ?? null} />
          <BlockedBadge blockers={run.blockers ?? []} />
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "Unknown start"}
        </p>
      </div>
      <StatusBadge status={run.status} />
    </div>
  );
}

function WorkspaceRow({ ws }: { ws: { id: string; name: string; branchName: string | null; status: string } }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{ws.name}</span>
        {ws.branchName && (
          <span className="text-xs text-muted-foreground truncate">{ws.branchName}</span>
        )}
      </div>
      <StatusBadge status={ws.status} />
    </div>
  );
}

function ServiceRow({ svc }: { svc: { id: string; serviceName: string; status: string; url: string | null; ownerAgentId: string | null } }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <div className="min-w-0">
        <p className="font-medium truncate">{svc.serviceName}</p>
        {svc.url && (
          <p className="text-xs text-muted-foreground truncate">{svc.url}</p>
        )}
      </div>
      <StatusBadge status={svc.status} />
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: { claimPath: string; claimType: string; conflictingAgentId: string; conflictingRunId: string } }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500 mt-0.5" />
      <div className="min-w-0">
        <p className="font-mono text-xs truncate">{conflict.claimPath}</p>
        <p className="text-xs text-muted-foreground">{conflict.claimType}</p>
      </div>
    </div>
  );
}

function StaleClaimRow({ claim }: { claim: { id: string; claimPath: string; claimType: string; minutesUntilExpiry: number } }) {
  const isExpiring = claim.minutesUntilExpiry <= 1;
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <Clock className={cn("h-4 w-4 shrink-0 mt-0.5", isExpiring ? "text-red-500" : "text-yellow-500")} />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs truncate">{claim.claimPath}</p>
        <p className="text-xs text-muted-foreground">
          {claim.minutesUntilExpiry <= 0
            ? "Expired"
            : `${claim.minutesUntilExpiry}m until expiry`}
        </p>
      </div>
    </div>
  );
}

function DegradedServiceRow({ svc }: { svc: { id: string; serviceName: string; status: string; healthStatus: string; url: string | null } }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0 text-red-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="font-medium truncate">{svc.serviceName}</p>
        <p className="text-xs text-muted-foreground">
          {svc.status} / {svc.healthStatus}
        </p>
      </div>
    </div>
  );
}

function StuckRunRow({ run }: { run: { id: string; issueIdentifier: string | null; issueTitle: string | null; status: string; minutesWaiting: number } }) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-start gap-2 py-2 text-sm cursor-pointer hover:bg-muted/50 -mx-2 px-2 rounded transition-colors"
      onClick={() => run.issueIdentifier && navigate(`/issues/${run.issueIdentifier}`)}
      role={run.issueIdentifier ? "button" : undefined}
      tabIndex={run.issueIdentifier ? 0 : undefined}
      onKeyDown={(e) => { if (run.issueIdentifier && e.key === "Enter") navigate(`/issues/${run.issueIdentifier}`); }}
    >
      <Clock className="h-4 w-4 shrink-0 text-yellow-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        {run.issueIdentifier ? (
          <span className="text-blue-600 dark:text-blue-400 font-medium hover:underline">{run.issueIdentifier}</span>
        ) : (
          <span className="text-muted-foreground">No issue</span>
        )}
        <span className="text-muted-foreground ml-1">{run.issueTitle ?? ""}</span>
        <p className="text-xs text-muted-foreground">
          Waiting {run.minutesWaiting}m
        </p>
      </div>
    </div>
  );
}

function HandoffRow({ handoff }: { handoff: { id: string; agentName: string; swarmRole: string | null; issueIdentifier: string | null; summary: string; recommendedNextStep: string; avoidPaths: string[]; emittedAt: string } }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <ArrowRight className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="font-medium text-xs">{handoff.agentName}</span>
          {handoff.swarmRole && (
            <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
              {handoff.swarmRole}
            </span>
          )}
          {handoff.issueIdentifier && (
            <span className="text-xs text-muted-foreground">[{handoff.issueIdentifier}]</span>
          )}
        </div>
        <p className="text-xs truncate mt-0.5">{handoff.summary}</p>
        {handoff.avoidPaths.length > 0 && (
          <p className="text-xs text-amber-600 truncate mt-0.5">
            Avoid: {handoff.avoidPaths.slice(0, 2).join(", ")}{handoff.avoidPaths.length > 2 ? ` +${handoff.avoidPaths.length - 2}` : ""}
          </p>
        )}
        <p className="text-xs text-blue-500 truncate mt-0.5">
          Next: {handoff.recommendedNextStep}
        </p>
      </div>
    </div>
  );
}

function ClaimedPathsRow({ agent }: { agent: { agentId: string; agentName: string; role: string | null; pathCount: number; paths: string[]; issueIdentifier: string | null } }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <MapPin className="h-4 w-4 shrink-0 text-green-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="font-medium text-xs">{agent.agentName}</span>
          {agent.role && (
            <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
              {agent.role}
            </span>
          )}
          {agent.issueIdentifier && (
            <span className="text-xs text-muted-foreground">[{agent.issueIdentifier}]</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {agent.pathCount} path{agent.pathCount !== 1 ? "s" : ""} claimed
        </p>
        <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
          {agent.paths.slice(0, 3).join(", ")}{agent.paths.length > 3 ? ` +${agent.paths.length - 3}` : ""}
        </p>
      </div>
    </div>
  );
}

function AvoidPathsRow({ path, reason }: { path: string; reason: string }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <Ban className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs truncate">{path}</p>
        <p className="text-xs text-muted-foreground truncate">{reason}</p>
      </div>
    </div>
  );
}

function ProtectedPathsRow({ path }: { path: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5 text-sm">
      <Shield className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
      <div className="min-w-0">
        <p className="font-mono text-xs truncate">{path}</p>
      </div>
    </div>
  );
}

function AutoClaimSuggestionRow({ suggestion }: { suggestion: { source: string; path: string; claimType: string; reason: string; issueIdentifier?: string } }) {
  const sourceColors: Record<string, string> = {
    issue_labels: "text-purple-500 bg-purple-500/10",
    issue_description: "text-blue-500 bg-blue-500/10",
    issue_title: "text-violet-500 bg-violet-500/10",
    diff: "text-green-500 bg-green-500/10",
  };
  const colorClass = sourceColors[suggestion.source] ?? "text-muted bg-muted/50";
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <Lightbulb className="h-4 w-4 shrink-0 text-yellow-400 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <p className="font-mono text-xs truncate">{suggestion.path}</p>
          <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium", colorClass)}>
            {suggestion.source}
          </span>
          {suggestion.issueIdentifier && (
            <span className="text-xs text-muted-foreground">[{suggestion.issueIdentifier}]</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{suggestion.reason}</p>
      </div>
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: { id: string; artifactType: string; status: string; summary: string | null; actorAgentName: string | null; createdAt: string; verificationStatus?: string | null; mergeReadiness?: string | null; goal?: string | null; verdict?: string | null; filesChanged?: string[] | null } }) {
  const artifactTypeLabels: Record<string, string> = {
    planner: "Planner",
    plan_reviewer: "Plan Reviewer",
    executor: "Executor",
    reviewer: "Reviewer",
  };
  const typeColor: Record<string, string> = {
    planner: "text-blue-500 bg-blue-500/10",
    plan_reviewer: "text-violet-500 bg-violet-500/10",
    executor: "text-green-500 bg-green-500/10",
    reviewer: "text-amber-500 bg-amber-500/10",
  };
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium", typeColor[artifact.artifactType] ?? "text-muted bg-muted/50")}>
            {artifactTypeLabels[artifact.artifactType] ?? artifact.artifactType}
          </span>
          {artifact.actorAgentName && (
            <span className="text-xs text-muted-foreground">{artifact.actorAgentName}</span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {new Date(artifact.createdAt).toLocaleTimeString()}
          </span>
        </div>
        {artifact.summary && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{artifact.summary}</p>
        )}
        {artifact.verdict && (
          <p className="text-xs text-muted-foreground mt-0.5">Verdict: {artifact.verdict}</p>
        )}
        {artifact.verificationStatus && (
          <p className="text-xs text-muted-foreground mt-0.5">Status: {artifact.verificationStatus}</p>
        )}
        {artifact.mergeReadiness && (
          <p className={cn("text-xs font-medium mt-0.5", artifact.mergeReadiness === "ready" ? "text-green-600" : artifact.mergeReadiness === "blocked" ? "text-red-500" : "text-amber-500")}>
            {artifact.mergeReadiness === "ready" ? "✓" : artifact.mergeReadiness === "blocked" ? "✗" : "~"} merge: {artifact.mergeReadiness}
          </p>
        )}
      </div>
    </div>
  );
}

function LatestHandoffSummaryRow({ handoff }: { handoff: { agentName: string; swarmRole: string | null; issueIdentifier: string | null; summary: string; remainingWork: string[]; blockers: string[]; emittedAt: string } }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium text-sm">{handoff.agentName}</span>
        {handoff.swarmRole && (
          <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">{handoff.swarmRole}</span>
        )}
        {handoff.issueIdentifier && (
          <span className="text-xs text-muted-foreground">[{handoff.issueIdentifier}]</span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {new Date(handoff.emittedAt).toLocaleTimeString()}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{handoff.summary}</p>
      {handoff.remainingWork.length > 0 && (
        <p className="text-xs text-amber-600">
          Remaining: {handoff.remainingWork.slice(0, 2).join(", ")}
          {handoff.remainingWork.length > 2 ? ` +${handoff.remainingWork.length - 2}` : ""}
        </p>
      )}
      {handoff.blockers.length > 0 && (
        <p className="text-xs text-red-500">
          Blockers: {handoff.blockers.slice(0, 2).join(", ")}
          {handoff.blockers.length > 2 ? ` +${handoff.blockers.length - 2}` : ""}
        </p>
      )}
    </div>
  );
}

function FairnessSignal({ stuckRuns, activeRuns }: { stuckRuns: number; activeRuns: number }) {
  const total = stuckRuns + activeRuns;
  const starvationRatio = total > 0 ? stuckRuns / total : 0;
  const isStarving = starvationRatio >= 0.3 && stuckRuns > 0;
  const isWarning = stuckRuns > 0 && !isStarving;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Scale className={cn("h-4 w-4", isStarving ? "text-red-500" : isWarning ? "text-amber-500" : "text-green-500")} />
          <span className="text-xs font-medium">Queue Health</span>
        </div>
        <span className={cn(
          "text-xs font-mono",
          isStarving ? "text-red-500" : isWarning ? "text-amber-500" : "text-green-500"
        )}>
          {stuckRuns === 0 ? "Healthy" : isStarving ? `High pressure` : `${stuckRuns}/${total} queued`}
        </span>
      </div>
      {isStarving && (
        <p className="text-xs text-red-500/80">
          {stuckRuns} run{stuckRuns !== 1 ? "s" : ""} waiting — {Math.round(starvationRatio * 100)}% of active capacity
        </p>
      )}
      {isWarning && (
        <p className="text-xs text-amber-500/80">
          {stuckRuns} queued run{stuckRuns !== 1 ? "s" : ""} — monitor queue pressure
        </p>
      )}
    </div>
  );
}

function ReviewQueueItem({ handoff }: { handoff: { agentName: string; swarmRole: string | null; issueIdentifier: string | null; summary: string; recommendedNextStep: string; emittedAt: string; verificationStatus?: string | null; mergeReadiness?: string | null; blockers?: string[] } }) {
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <ClipboardCheck className="h-4 w-4 shrink-0 text-blue-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="font-medium text-xs">{handoff.agentName}</span>
          {handoff.swarmRole && (
            <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded">
              {handoff.swarmRole}
            </span>
          )}
          {handoff.issueIdentifier && (
            <span className="text-xs text-blue-500">[{handoff.issueIdentifier}]</span>
          )}
          <ReviewSignalBadge verificationStatus={handoff.verificationStatus ?? null} mergeReadiness={handoff.mergeReadiness ?? null} />
          {(handoff.blockers?.length ?? 0) > 0 && (
            <span className="text-xs text-red-500 font-medium shrink-0" title={handoff.blockers?.join("; ")}>
              ⚠ blocked
            </span>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            {new Date(handoff.emittedAt).toLocaleTimeString()}
          </span>
        </div>
        <p className="text-xs truncate mt-0.5">{handoff.summary}</p>
        <p className="text-xs text-blue-500 truncate mt-0.5">
          Next: {handoff.recommendedNextStep}
        </p>
      </div>
    </div>
  );
}

function CollaborationHintRow({ hint }: { hint: { type: string; message: string; urgency: string; relatedIssue?: string | null } }) {
  const urgencyColors: Record<string, string> = {
    high: "text-red-500 bg-red-500/10",
    medium: "text-amber-500 bg-amber-500/10",
    low: "text-green-500 bg-green-500/10",
  };
  const colorClass = urgencyColors[hint.urgency] ?? "text-muted bg-muted/50";
  const typeIcons: Record<string, string> = {
    role_coordination: "→",
    review_needed: "✓",
    blocked: "⚠️",
    conflict_risk: "⚠️",
  };
  return (
    <div className="flex items-start gap-2 py-1.5 text-sm">
      <span className="text-xs shrink-0">{typeIcons[hint.type] ?? "•"}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs">{hint.message}</p>
        {hint.relatedIssue && (
          <span className="text-xs text-blue-500 ml-1">[{hint.relatedIssue}]</span>
        )}
      </div>
      <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium shrink-0", colorClass)}>
        {hint.urgency}
      </span>
    </div>
  );
}

function ArtifactChainPips({ chain }: { chain: string[] }) {
  const typeOrder = ["planner", "plan_reviewer", "executor", "reviewer"];
  const produced = new Set(chain);
  return (
    <div className="flex items-center gap-0.5">
      {typeOrder.map((type) => (
        <span
          key={type}
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            produced.has(type) ? "bg-blue-500" : "bg-muted"
          )}
          title={type}
        />
      ))}
    </div>
  );
}

function IssueWorkflowRow({ summary }: { summary: { issueIdentifier: string | null; issueTitle: string | null; phase: string | null; assigneeAgentName: string | null; isRework: boolean; reworkCount: number; blockedReason: string | null; expectedNextRole: string | null; expectedNextPhase: string | null; artifactChain: string[] } }) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-start gap-2 py-2 text-sm cursor-pointer hover:bg-muted/50 -mx-2 px-2 rounded transition-colors"
      onClick={() => summary.issueIdentifier && navigate(`/issues/${summary.issueIdentifier}`)}
      role={summary.issueIdentifier ? "button" : undefined}
      tabIndex={summary.issueIdentifier ? 0 : undefined}
      onKeyDown={(e) => { if (summary.issueIdentifier && e.key === "Enter") navigate(`/issues/${summary.issueIdentifier}`); }}
    >
      <ArtifactChainPips chain={summary.artifactChain} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {summary.issueIdentifier ? (
            <span className="text-blue-600 dark:text-blue-400 font-medium hover:underline text-xs">{summary.issueIdentifier}</span>
          ) : (
            <span className="text-muted-foreground text-xs">No issue</span>
          )}
          {summary.phase && <PhaseBadge phase={summary.phase} />}
          {summary.assigneeAgentName && (
            <span className="text-xs text-muted-foreground shrink-0">{summary.assigneeAgentName}</span>
          )}
          {summary.isRework && (
            <span className="inline-flex items-center gap-0.5 text-xs text-amber-500 shrink-0" title={`${summary.reworkCount} rework(s)`}>
              <Repeat className="h-3 w-3" />
              {summary.reworkCount}
            </span>
          )}
          {summary.blockedReason && (
            <span className="text-xs text-red-500 shrink-0" title={summary.blockedReason}>⚠ {summary.blockedReason}</span>
          )}
          {summary.expectedNextRole && (
            <span className="inline-flex items-center gap-0.5 text-xs text-blue-500 shrink-0" title={`Next: ${summary.expectedNextRole} → ${summary.expectedNextPhase}`}>
              <ChevronRight className="h-3 w-3" />
              {summary.expectedNextRole}
            </span>
          )}
        </div>
        {summary.issueTitle && (
          <p className="text-xs text-muted-foreground truncate">{summary.issueTitle}</p>
        )}
      </div>
    </div>
  );
}

export function SwarmCockpit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("projectId") ?? undefined;

  useEffect(() => {
    const crumbs = projectId
      ? [{ label: "Projects", href: "/projects" }, { label: "Swarm Cockpit" }]
      : [{ label: "Swarm Cockpit" }];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, projectId]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: queryKeys.swarmDigest(selectedCompanyId!, projectId),
    queryFn: () => swarmDigestApi.getCockpitDigest(selectedCompanyId!, projectId),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Select a company to view the swarm cockpit.
      </div>
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-destructive">
        Failed to load swarm digest: {error?.message ?? "Unknown error"}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {projectId && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="h-3 w-3" />
          <span>Project-scoped view</span>
        </div>
      )}
      <SummaryStrip data={data} isFetching={isFetching} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Critical — alerts first */}
        <SectionCard
          title="File Claim Conflicts"
          icon={AlertTriangle}
          id="conflicts"
          className="md:col-span-2 lg:col-span-1"
          alertCount={data.fileClaimConflicts.length}
        >
          {data.fileClaimConflicts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No conflicts</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.fileClaimConflicts.slice(0, 10).map((conflict, i) => (
                <ConflictRow key={i} conflict={conflict} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Stuck Runs"
          icon={Clock}
          id="stuck-runs"
          className="md:col-span-2 lg:col-span-1"
          alertCount={data.runsStuck.length}
        >
          {data.runsStuck.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No stuck runs</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.runsStuck.slice(0, 10).map((run) => (
                <StuckRunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Failed/Degraded Services"
          icon={AlertCircle}
          id="degraded-services"
          className="md:col-span-2 lg:col-span-1"
          alertCount={data.servicesDegraded.length}
        >
          {data.servicesDegraded.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No degraded services</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.servicesDegraded.slice(0, 10).map((svc) => (
                <DegradedServiceRow key={svc.id} svc={svc} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Stale Claims"
          icon={Clock}
          id="stale-claims"
          className="md:col-span-2 lg:col-span-1"
          alertCount={data.fileClaimStale.filter(c => c.minutesUntilExpiry <= 1).length}
        >
          {data.fileClaimStale.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No expiring claims</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.fileClaimStale.slice(0, 10).map((claim) => (
                <StaleClaimRow key={claim.id} claim={claim} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* Operational */}
        <SectionCard title="Hot Slot Usage" icon={Zap} className="md:col-span-2 lg:col-span-1">
          <HotSlotMeter current={data.hotSlotUsage.current} max={data.hotSlotUsage.max} />
          {data.queuedHotRunsCount > 0 && (
            <p className="mt-2 text-xs text-yellow-500">
              {data.queuedHotRunsCount} queued hot runs waiting
            </p>
          )}
        </SectionCard>

        <SectionCard title="Active Runs" icon={CircleDot} id="active-runs" className="md:col-span-2 lg:col-span-1">
          {data.activeRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active runs</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.activeRuns.slice(0, 10).map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Active Agents" icon={Bot} id="active-agents" className="md:col-span-2 lg:col-span-1">
          {data.activeAgents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active agents</p>
          ) : (
            <div className="divide-y divide-border">
              {data.activeAgents.slice(0, 8).map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
              {data.activeAgents.length > 8 && (
                <p className="text-xs text-muted-foreground py-2 text-center">
                  +{data.activeAgents.length - 8} more
                </p>
              )}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Active Workspaces" icon={Folder} className="md:col-span-2 lg:col-span-1">
          {data.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active workspaces</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.workspaces.slice(0, 10).map((ws) => (
                <WorkspaceRow key={ws.id} ws={ws} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Runtime Services" icon={Zap} className="md:col-span-2 lg:col-span-1">
          {data.services.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No running services</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.services.slice(0, 10).map((svc) => (
                <ServiceRow key={svc.id} svc={svc} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Queue Fairness" icon={Scale} className="md:col-span-2 lg:col-span-1">
          <FairnessSignal stuckRuns={data.runsStuck.length} activeRuns={data.activeRuns.length} />
        </SectionCard>

        {/* Collaboration & Review */}
        <SectionCard
          title="Review Queue"
          icon={ClipboardCheck}
          id="review-queue"
          className="md:col-span-2 lg:col-span-1"
          alertCount={(data.reviewQueue?.readyForReview?.length ?? 0) + (data.reviewQueue?.blocked?.length ?? 0)}
        >
          {!data.reviewQueue || (data.reviewQueue.readyForReview.length === 0 && data.reviewQueue.blocked.length === 0) ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No items need review</p>
          ) : (
            <div className="divide-y divide-border max-h-64 overflow-y-auto">
              {data.reviewQueue.blocked.slice(0, 5).map((handoff) => (
                <ReviewQueueItem key={`blocked-${handoff.id}`} handoff={handoff} />
              ))}
              {data.reviewQueue.readyForReview.slice(0, 5).map((handoff) => (
                <ReviewQueueItem key={`ready-${handoff.id}`} handoff={handoff} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Issue Workflow" icon={UserCheck} className="md:col-span-2 lg:col-span-1">
          {!data.issueWorkflowSummary || data.issueWorkflowSummary.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active issues</p>
          ) : (
            <div className="divide-y divide-border max-h-64 overflow-y-auto">
              {data.issueWorkflowSummary.slice(0, 10).map((summary) => (
                <IssueWorkflowRow key={summary.issueId} summary={summary} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Collaboration Hints"
          icon={MessageSquare}
          className="md:col-span-2 lg:col-span-1"
          alertCount={data.collaborationHints?.filter(h => h.urgency === "high").length ?? 0}
        >
          {!data.collaborationHints || data.collaborationHints.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active hints</p>
          ) : (
            <div className="divide-y divide-border max-h-64 overflow-y-auto">
              {data.collaborationHints.slice(0, 8).map((hint, i) => (
                <CollaborationHintRow key={i} hint={hint} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* Informational */}
        <SectionCard title="Latest Handoff" icon={Star} className="md:col-span-2 lg:col-span-2">
          {!data.latestHandoff ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No handoff yet</p>
          ) : (
            <LatestHandoffSummaryRow handoff={data.latestHandoff} />
          )}
        </SectionCard>

        <SectionCard title="Recent Handoffs" icon={ArrowRight} className="md:col-span-2 lg:col-span-2">
          {data.recentHandoffs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No recent handoffs</p>
          ) : (
            <div className="divide-y divide-border max-h-64 overflow-y-auto">
              {data.recentHandoffs.slice(0, 10).map((handoff) => (
                <HandoffRow key={handoff.id} handoff={handoff} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Claimed Paths" icon={MapPin} className="md:col-span-2 lg:col-span-1">
          {data.claimedPathsSummary.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No active claims</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.claimedPathsSummary.byAgent.slice(0, 8).map((agent) => (
                <ClaimedPathsRow key={agent.agentId} agent={agent} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Avoid Paths" icon={Ban} className="md:col-span-2 lg:col-span-1">
          {data.recommendedAvoidPaths.paths.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No avoid paths</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.recommendedAvoidPaths.paths.slice(0, 10).map((path, i) => (
                <AvoidPathsRow key={path} path={path} reason={data.recommendedAvoidPaths.reasons[i] ?? ""} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Protected Paths" icon={Shield} className="md:col-span-2 lg:col-span-1">
          <p className="text-xs text-muted-foreground mb-2">
            {data.protectedPaths.enforcement === "hard_block" ? "Hard Block" : "Soft Warning"} — {data.protectedPaths.defaultPatterns.length} defaults, {data.protectedPaths.configurablePatterns.length} project
          </p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {data.protectedPaths.defaultPatterns.slice(0, 10).map((path) => (
              <ProtectedPathsRow key={path} path={path} />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Auto-Claim Suggestions" icon={Lightbulb} className="md:col-span-2 lg:col-span-1">
          {data.autoClaimSuggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No suggestions</p>
          ) : (
            <div className="divide-y divide-border max-h-48 overflow-y-auto">
              {data.autoClaimSuggestions.slice(0, 8).map((suggestion, i) => (
                <AutoClaimSuggestionRow key={i} suggestion={suggestion} />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Recent Artifacts"
          icon={FileText}
          className="md:col-span-2 lg:col-span-2"
        >
          {!data.recentArtifacts || data.recentArtifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No recent artifacts</p>
          ) : (
            <div className="divide-y divide-border max-h-64 overflow-y-auto">
              {data.recentArtifacts.slice(0, 10).map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="text-xs text-muted-foreground text-right">
        Last updated: {new Date(data.generatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

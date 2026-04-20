import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { swarmDigestApi, type SwarmCockpitDigest } from "@/api/swarm-digest";
import { PageSkeleton } from "@/components/PageSkeleton";
import { cn } from "@/lib/utils";
import { useSearchParams } from "@/lib/router";
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
} from "lucide-react";

function SectionCard({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {title}
        </h3>
      </div>
      {children}
    </div>
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

function RunRow({ run }: { run: { id: string; agentId: string; issueIdentifier: string | null; issueTitle: string | null; status: string; startedAt: string | null; swarmRole: string | null } }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="truncate font-medium">
            {run.issueIdentifier ? `[${run.issueIdentifier}]` : "No issue"} {run.issueTitle ?? ""}
          </p>
          {run.swarmRole && (
            <span className="text-xs text-muted-foreground bg-muted px-1 py-0.5 rounded shrink-0">
              {run.swarmRole}
            </span>
          )}
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
  return (
    <div className="flex items-start gap-2 py-2 text-sm">
      <Clock className="h-4 w-4 shrink-0 text-yellow-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {run.issueIdentifier ? `[${run.issueIdentifier}]` : "No issue"} {run.issueTitle ?? ""}
        </p>
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

function FairnessSignal({ stuckRuns, activeRuns }: { stuckRuns: number; activeRuns: number }) {
  const isHealthy = stuckRuns === 0 || activeRuns === 0;
  const starvationRatio = activeRuns > 0 ? stuckRuns / activeRuns : 0;
  const isStarving = starvationRatio >= 0.3 && stuckRuns > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Scale className={cn("h-4 w-4", isStarving ? "text-red-500" : "text-green-500")} />
          <span className="text-xs font-medium">Queue Health</span>
        </div>
        <span className={cn(
          "text-xs font-mono",
          isStarving ? "text-red-500" : "text-green-500"
        )}>
          {isHealthy ? "Healthy" : `${stuckRuns}/${activeRuns + stuckRuns} queued`}
        </span>
      </div>
      {isStarving && (
        <p className="text-xs text-red-500/80">
          High queue pressure: {stuckRuns} run{stuckRuns !== 1 ? "s" : ""} waiting {" "}
          {Math.round(starvationRatio * 100)}% of active capacity
        </p>
      )}
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

  const { data, isLoading, error } = useQuery({
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <SectionCard title="Active Agents" icon={Bot} className="md:col-span-2 lg:col-span-1">
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

        <SectionCard title="Hot Slot Usage" icon={Zap} className="md:col-span-2 lg:col-span-1">
          <HotSlotMeter current={data.hotSlotUsage.current} max={data.hotSlotUsage.max} />
          {data.queuedHotRunsCount > 0 && (
            <p className="mt-2 text-xs text-yellow-500">
              {data.queuedHotRunsCount} queued hot runs waiting
            </p>
          )}
        </SectionCard>

        <SectionCard title="Active Runs" icon={CircleDot} className="md:col-span-2 lg:col-span-1">
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

        <SectionCard title="File Claim Conflicts" icon={AlertTriangle} className="md:col-span-2 lg:col-span-1">
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

        <SectionCard title="Stale Claims" icon={Clock} className="md:col-span-2 lg:col-span-1">
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

        <SectionCard title="Failed/Degraded Services" icon={AlertCircle} className="md:col-span-2 lg:col-span-1">
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

        <SectionCard title="Stuck Runs" icon={Clock} className="md:col-span-2 lg:col-span-1">
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
            Hard-blocked patterns ({data.protectedPaths.enforcedBy})
          </p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {data.protectedPaths.paths.slice(0, 15).map((path) => (
              <ProtectedPathsRow key={path} path={path} />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Queue Fairness" icon={Scale} className="md:col-span-2 lg:col-span-1">
          <FairnessSignal stuckRuns={data.runsStuck.length} activeRuns={data.activeRuns.length} />
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
      </div>

      <div className="text-xs text-muted-foreground text-right">
        Last updated: {new Date(data.generatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

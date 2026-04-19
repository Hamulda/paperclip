import { useEffect, useRef, useState } from "react";
import { Plus, X, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";

const DEBOUNCE_MS = 300;

export interface ServiceEntry {
  name: string;
  command: string;
  cwd?: string;
  lifecycle?: "shared" | "ephemeral";
  reuseScope?: "project_workspace" | "execution_workspace" | "run" | "agent";
}

const inputClass =
  "w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none placeholder:text-muted-foreground/40";

const labelClass = "text-[11px] text-muted-foreground";

function ServiceRow({
  service,
  index,
  onUpdate,
  onRemove,
  canRemove,
  errors,
}: {
  service: ServiceEntry;
  index: number;
  onUpdate: (patch: Partial<ServiceEntry>) => void;
  onRemove: () => void;
  canRemove: boolean;
  errors?: string[];
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-medium">{service.name || `Service ${index + 1}`}</span>
        </button>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 pl-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <label className={labelClass}>Name *</label>
              <input
                className={inputClass}
                value={service.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                placeholder="web"
              />
            </div>
            <div className="space-y-0.5">
              <label className={labelClass}>Command *</label>
              <input
                className={inputClass}
                value={service.command}
                onChange={(e) => onUpdate({ command: e.target.value })}
                placeholder="pnpm dev"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <label className={labelClass}>Working directory</label>
              <input
                className={inputClass}
                value={service.cwd ?? ""}
                onChange={(e) => onUpdate({ cwd: e.target.value || undefined })}
                placeholder="."
              />
            </div>
            <div className="space-y-0.5">
              <label className={labelClass}>Lifecycle</label>
              <select
                className={cn(inputClass, "bg-background")}
                value={service.lifecycle ?? "shared"}
                onChange={(e) =>
                  onUpdate({ lifecycle: (e.target.value as "shared" | "ephemeral") || undefined })
                }
              >
                <option value="shared">Shared</option>
                <option value="ephemeral">Ephemeral</option>
              </select>
            </div>
          </div>

          <div className="space-y-0.5">
            <label className={labelClass}>Reuse scope</label>
            <select
              className={cn(inputClass, "bg-background")}
              value={service.reuseScope ?? "project_workspace"}
              onChange={(e) =>
                onUpdate({
                  reuseScope: (e.target.value as ServiceEntry["reuseScope"]) || undefined,
                })
              }
            >
              <option value="project_workspace">Project workspace</option>
              <option value="execution_workspace">Execution workspace</option>
              <option value="run">Run</option>
              <option value="agent">Agent</option>
            </select>
          </div>
        </div>
      )}

      {errors && errors.length > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-destructive">
          <AlertCircle className="h-3 w-3" />
          <span>{errors.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function parseServices(value: unknown): ServiceEntry[] {
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const services = obj.services;
  if (!Array.isArray(services)) return [];
  return services
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((s) => ({
      name: typeof s.name === "string" ? s.name : "",
      command: typeof s.command === "string" ? s.command : "",
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
      lifecycle:
        s.lifecycle === "shared" || s.lifecycle === "ephemeral" ? s.lifecycle : undefined,
      reuseScope:
        typeof s.reuseScope === "string" &&
        ["project_workspace", "execution_workspace", "run", "agent"].includes(s.reuseScope)
          ? (s.reuseScope as ServiceEntry["reuseScope"])
          : undefined,
    }));
}

function validateServices(services: ServiceEntry[]): Map<number, string[]> {
  const errors = new Map<number, string[]>();
  services.forEach((service, index) => {
    const rowErrors: string[] = [];
    if (!service.name.trim()) rowErrors.push("name is required");
    if (!service.command.trim()) rowErrors.push("command is required");
    if (rowErrors.length > 0) errors.set(index, rowErrors);
  });
  return errors;
}

interface WorkspaceServicesEditorProps {
  value: Record<string, unknown> | null;
  onChange: (value: Record<string, unknown> | null) => void;
}

export function WorkspaceServicesEditor({ value, onChange }: WorkspaceServicesEditorProps) {
  const [services, setServices] = useState<ServiceEntry[]>(() => parseServices(value));
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState(() =>
    value ? JSON.stringify(value, null, 2) : "",
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const valueRef = useRef(value);
  const emittingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (emittingRef.current) {
      emittingRef.current = false;
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      valueRef.current = value;
      setServices(parseServices(value));
      setJsonText(value ? JSON.stringify(value, null, 2) : "");
      setJsonError(null);
    }
  }, [value]);

  const errors = validateServices(services);

  function emit(nextServices: ServiceEntry[]) {
    const serialized = serializeServices(nextServices);
    const nextValue = serialized.services.length > 0 ? serialized : null;
    if (nextValue === valueRef.current) return;
    emittingRef.current = true;
    onChange(nextValue);
  }

  function scheduleEmit(nextServices: ServiceEntry[]) {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      emit(nextServices);
    }, DEBOUNCE_MS);
  }

  function serializeServices(services: ServiceEntry[]): { services: unknown[] } {
    return {
      services: services
        .filter((s) => s.name.trim() || s.command.trim())
        .map((s) => ({
          ...(s.name.trim() && { name: s.name.trim() }),
          ...(s.command.trim() && { command: s.command.trim() }),
          ...(s.cwd?.trim() && { cwd: s.cwd.trim() }),
          ...(s.lifecycle && { lifecycle: s.lifecycle }),
          ...(s.reuseScope && { reuseScope: s.reuseScope }),
        })),
    };
  }

  function updateService(index: number, patch: Partial<ServiceEntry>) {
    const next = services.map((s, i) => (i === index ? { ...s, ...patch } : s));
    setServices(next);
    scheduleEmit(next);
  }

  function addService() {
    const next = [...services, { name: "", command: "" }];
    setServices(next);
    scheduleEmit(next);
  }

  function removeService(index: number) {
    const next = services.filter((_, i) => i !== index);
    setServices(next);
    scheduleEmit(next);
  }

  function handleJsonChange(text: string) {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      emittingRef.current = true;
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const nextValue = parsed;
      if (nextValue === valueRef.current) return;
      setJsonError(null);
      emittingRef.current = true;
      onChange(parsed);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const isJsonMode = showJson || jsonError !== null;
  const hasErrors = errors.size > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {services.length} service{services.length !== 1 ? "s" : ""} configured
          </span>
          {hasErrors && (
            <span className="text-[10px] text-destructive">
              {errors.size} incomplete
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowJson((s) => !s)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showJson ? "Structured" : "JSON"}
          </button>
        </div>
      </div>

      {isJsonMode ? (
        <div className="space-y-1">
          <textarea
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
            rows={6}
            className={cn(
              inputClass,
              "resize-none",
              jsonError && "border-destructive",
            )}
            placeholder={'{"services": [{"name": "web", "command": "pnpm dev"}]}'}
          />
          {jsonError && (
            <p className="text-[11px] text-destructive">{jsonError}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {services.length === 0 ? (
            <p className="text-[11px] text-muted-foreground py-2">
              No services configured. Click &quot;Add service&quot; to start.
            </p>
          ) : (
            services.map((service, index) => (
              <ServiceRow
                key={index}
                service={service}
                index={index}
                onUpdate={(patch) => updateService(index, patch)}
                onRemove={() => removeService(index)}
                canRemove={true}
                errors={errors.get(index)}
              />
            ))
          )}
          <button
            type="button"
            onClick={addService}
            className="inline-flex items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add service
          </button>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Services run in isolated execution workspaces. Shared services persist across runs.
      </p>
    </div>
  );
}

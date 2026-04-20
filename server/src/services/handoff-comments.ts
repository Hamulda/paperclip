// =============================================================================
// Structured Handoff Comment Template & Parser
// =============================================================================

export const HANDOFF_COMMENT_PREFIX = "<!-- SWARM_HANDOFF";
export const HANDOFF_COMMENT_VERSION = "1.0";

export interface StructuredHandoff {
  version: string;
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  swarmRole: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
  avoidPaths: string[];
  emittedAt: string;
}

function escapeHandoffValue(value: string): string {
  return value.replace(/<!--/g, "<!--~").replace(/-->/g, "~-->");
}

function unescapeHandoffValue(value: string): string {
  return value.replace(/<!--~/g, "<!--").replace(/~-->/g, "-->");
}

function parseHandoffList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.replace(/^[\s-]+/, "").trim())
    .filter(Boolean);
}

export function buildHandoffComment(input: {
  agentId: string;
  agentName: string;
  runId: string;
  issueId: string | null;
  swarmRole?: string | null;
  summary: string;
  filesTouched: string[];
  currentState: string;
  remainingWork: string[];
  blockers: string[];
  recommendedNextStep: string;
  avoidPaths?: string[];
}): string {
  const escaped = {
    summary: escapeHandoffValue(input.summary),
    currentState: escapeHandoffValue(input.currentState),
    recommendedNextStep: escapeHandoffValue(input.recommendedNextStep),
  };

  const lines: string[] = [
    `<!-- SWARM_HANDOFF v${HANDOFF_COMMENT_VERSION} -->`,
    `<!-- AGENT_ID:${input.agentId} -->`,
    `<!-- AGENT_NAME:${input.agentName} -->`,
    `<!-- RUN_ID:${input.runId} -->`,
    `<!-- ISSUE_ID:${input.issueId ?? ""} -->`,
    `<!-- SWARM_ROLE:${input.swarmRole ?? ""} -->`,
    ``,
    `## Summary`,
    `${escaped.summary}`,
    ``,
    `## Files touched`,
    ...input.filesTouched.map((f) => `- ${f}`),
    ``,
    `## Current state`,
    `${escaped.currentState}`,
    ``,
    `## Remaining work`,
    ...input.remainingWork.map((r) => `- ${r}`),
    ``,
    ...(input.blockers.length > 0
      ? [`## Blockers`, ...input.blockers.map((b) => `- ${b}`), ``]
      : []),
    `## Recommended next step`,
    `${escaped.recommendedNextStep}`,
    ``,
    ...(input.avoidPaths && input.avoidPaths.length > 0
      ? [`## Avoid paths`, ...input.avoidPaths.map((p) => `- ${p}`), ``]
      : []),
    `<!-- EMITTED_AT:${new Date().toISOString()} -->`,
  ];

  return lines.join("\n");
}

export function parseHandoffComment(body: string): StructuredHandoff | null {
  if (!body.includes(HANDOFF_COMMENT_PREFIX)) {
    return null;
  }

  const lines = body.split("\n");
  const metadata: Record<string, string> = {};
  const sectionOrder: string[] = [];
  const sections: Record<string, string[]> = {};

  let currentSection: string | null = null;
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Parse SWARM_HANDOFF version line: <!-- SWARM_HANDOFF v1.0 -->
    const versionMatch = line.match(/^<!--\s*SWARM_HANDOFF\s+v([\d.]+)\s*-->$/);
    if (versionMatch) {
      metadata["VERSION"] = versionMatch[1];
      continue;
    }

    // Parse metadata comments: <!-- KEY:value -->
    const metaMatch = line.match(/^<!--\s*([A-Z_]+):(.+)\s*-->$/);
    if (metaMatch) {
      metadata[metaMatch[1]] = metaMatch[2].trim();
      continue;
    }

    // Section headers
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sectionOrder.push(currentSection);
      sections[currentSection] = [];
      inSection = true;
      continue;
    }

    // Content lines
    if (inSection && currentSection) {
      if (line.match(/^<!-- .+ -->$/)) {
        // End marker or other metadata comment
        continue;
      }
      sections[currentSection].push(line);
    }
  }

  // Extract raw section content and unescape
  const getRawSection = (name: string): string =>
    unescapeHandoffValue(sections[name]?.join("\n").trim() ?? "");

  const getListSection = (name: string): string[] => {
    const raw = getRawSection(name);
    return parseHandoffList(raw);
  };

  return {
    version: metadata["VERSION"] ?? "1.0",
    agentId: metadata["AGENT_ID"] ?? "",
    agentName: metadata["AGENT_NAME"] ?? "",
    runId: metadata["RUN_ID"] ?? "",
    issueId: metadata["ISSUE_ID"] || null,
    swarmRole: metadata["SWARM_ROLE"] || null,
    summary: getRawSection("Summary"),
    filesTouched: getListSection("Files touched"),
    currentState: getRawSection("Current state"),
    remainingWork: getListSection("Remaining work"),
    blockers: getListSection("Blockers"),
    recommendedNextStep: getRawSection("Recommended next step"),
    avoidPaths: getListSection("Avoid paths"),
    emittedAt: metadata["EMITTED_AT"] ?? "",
  };
}

export function isHandoffComment(body: string): boolean {
  return body.includes(HANDOFF_COMMENT_PREFIX);
}
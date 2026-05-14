// scopeDir: top-level source directory whose contents are agent-specific and
// must be copied verbatim only when that agent is selected. null = no scope dir.
export const AGENTS = [
  { id: "claude", label: "Claude", filename: "CLAUDE.md", scopeDir: ".claude" },
  { id: "codex", label: "Codex", filename: "AGENTS.md", scopeDir: ".codex" },
  { id: "gemini", label: "Gemini", filename: "GEMINI.md", scopeDir: null },
  { id: "cursor", label: "Cursor", filename: ".cursorrules", scopeDir: ".cursor" },
  { id: "windsurf", label: "Windsurf", filename: ".windsurfrules", scopeDir: null },
  { id: "cline", label: "Cline", filename: ".clinerules", scopeDir: null },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

// A source file is a "rule file" only if its basename is one of these
// canonical names. Repo authors pick CLAUDE.md or AGENTS.md as the single
// source of truth per directory; we render it to the user's selected
// agent filenames at install time.
export const CANONICAL_RULE_FILENAMES = new Set(["CLAUDE.md", "AGENTS.md"]);

export function isRuleFile(relPath) {
  const base = relPath.split("/").pop();
  return CANONICAL_RULE_FILENAMES.has(base);
}

// If the given posix path lives inside an agent's scope directory
// (e.g. ".claude/rules/foo.md"), return that agent. Otherwise null.
export function scopeDirOwner(relPath) {
  const top = relPath.split("/")[0];
  if (!top) return null;
  for (const a of AGENTS) {
    if (a.scopeDir && a.scopeDir === top) return a;
  }
  return null;
}

export const SCOPE_DIRS = new Set(
  AGENTS.filter((a) => a.scopeDir).map((a) => a.scopeDir)
);

export function agentById(id) {
  return BY_ID.get(id) ?? null;
}

export function parseAgentList(str) {
  if (!str) return [];
  if (str === "all") return [...AGENTS];
  const ids = str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const id of ids) {
    const a = agentById(id);
    if (!a) {
      throw new Error(
        `unknown agent "${id}". known: ${AGENTS.map((x) => x.id).join(", ")}`
      );
    }
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    result.push(a);
  }
  return result;
}

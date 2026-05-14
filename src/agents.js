export const AGENTS = [
  { id: "claude", label: "Claude", filename: "CLAUDE.md" },
  { id: "codex", label: "Codex", filename: "AGENTS.md" },
  { id: "gemini", label: "Gemini", filename: "GEMINI.md" },
  { id: "cursor", label: "Cursor", filename: ".cursorrules" },
  { id: "windsurf", label: "Windsurf", filename: ".windsurfrules" },
  { id: "cline", label: "Cline", filename: ".clinerules" },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
export const RULE_FILENAMES = new Set(AGENTS.map((a) => a.filename));

export function isRuleFile(relPath) {
  const base = relPath.split("/").pop();
  return RULE_FILENAMES.has(base);
}

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

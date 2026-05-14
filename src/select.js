import fs from "node:fs";
import path from "node:path";
import { multiselect, isCancel, cancel } from "@clack/prompts";
import { AGENTS } from "./agents.js";

export async function selectAgents({ target, preselect } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "no TTY available for interactive selection. pass --agents <list> " +
        `(e.g. --agents claude,codex) or --agents all. known: ${AGENTS.map((a) => a.id).join(", ")}`
    );
  }

  const defaults =
    preselect && preselect.length > 0
      ? new Set(preselect)
      : detectFromTarget(target);

  const result = await multiselect({
    message: "Select agents to install for:",
    options: AGENTS.map((a) => ({
      value: a.id,
      label: `${a.label.padEnd(10)} (${a.filename})`,
    })),
    initialValues: AGENTS.filter((a) => defaults.has(a.id)).map((a) => a.id),
    required: true,
  });

  if (isCancel(result)) {
    cancel("Cancelled.");
    process.exit(130);
  }

  const picked = new Set(result);
  return AGENTS.filter((a) => picked.has(a.id));
}

function detectFromTarget(target) {
  // Preselect agents that already have rule files or a scope directory
  // anywhere in the target tree.
  const found = new Set();
  if (!target || !fs.existsSync(target)) return new Set(["claude"]);

  const filenameToId = new Map(AGENTS.map((a) => [a.filename, a.id]));
  const scopeDirToId = new Map(
    AGENTS.filter((a) => a.scopeDir).map((a) => [a.scopeDir, a.id])
  );

  // Cheap check: any agent scopeDir at the target root counts.
  for (const [dirName, id] of scopeDirToId) {
    if (fs.existsSync(path.join(target, dirName))) found.add(id);
  }

  const stack = [target];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      visited++;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile() && filenameToId.has(e.name)) {
        found.add(filenameToId.get(e.name));
      }
    }
  }

  return found.size > 0 ? found : new Set(["claude"]);
}

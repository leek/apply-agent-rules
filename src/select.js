import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { AGENTS } from "./agents.js";

export async function selectAgents({ target, preselect } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "no TTY available for interactive selection. pass --agents <list> " +
        `(e.g. --agents claude,codex) or --agents all. known: ${AGENTS.map((a) => a.id).join(", ")}`
    );
  }

  const defaults =
    preselect && preselect.length > 0 ? new Set(preselect) : detectFromTarget(target);
  const selected = new Set(defaults);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  try {
    while (true) {
      process.stdout.write("\nSelect agents to install for:\n");
      AGENTS.forEach((a, i) => {
        const mark = selected.has(a.id) ? "x" : " ";
        process.stdout.write(
          `  [${mark}] ${i + 1}. ${a.label.padEnd(10)} (${a.filename})\n`
        );
      });
      const ans = (
        await ask("\n  Numbers to toggle, 'a'=all, 'n'=none, ENTER=confirm: ")
      )
        .trim()
        .toLowerCase();

      if (ans === "") {
        if (selected.size === 0) {
          process.stdout.write("  (nothing selected — pick at least one)\n");
          continue;
        }
        break;
      }
      if (ans === "a") {
        AGENTS.forEach((a) => selected.add(a.id));
        continue;
      }
      if (ans === "n") {
        selected.clear();
        continue;
      }
      for (const tok of ans.split(/[\s,]+/)) {
        const n = Number.parseInt(tok, 10);
        if (!Number.isInteger(n) || n < 1 || n > AGENTS.length) continue;
        const id = AGENTS[n - 1].id;
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
      }
    }
  } finally {
    rl.close();
  }

  return AGENTS.filter((a) => selected.has(a.id));
}

function detectFromTarget(target) {
  // Preselect agents that already have rule files anywhere in the target tree.
  const found = new Set();
  if (!target || !fs.existsSync(target)) return new Set(["claude"]);

  const wanted = new Map(AGENTS.map((a) => [a.filename, a.id]));
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
      } else if (e.isFile() && wanted.has(e.name)) {
        found.add(wanted.get(e.name));
      }
    }
  }

  return found.size > 0 ? found : new Set(["claude"]);
}

import fs from "node:fs";
import path from "node:path";
import { resolveSource } from "./resolve-source.js";
import { globToRegex, toPosix } from "./glob.js";
import { isRuleFile, scopeDirOwner } from "./agents.js";
import {
  hashBuffer,
  hashFile,
  readLockfile,
  writeLockfile,
  sourceKey,
  LOCKFILE_NAME,
} from "./lockfile.js";

const DEFAULT_EXCLUDES = [
  ".git",
  ".git/**",
  ".github",
  ".github/**",
  "node_modules",
  "node_modules/**",
  ".DS_Store",
  "**/.DS_Store",
  "README.md",
  "**/README.md",
  "README",
  "**/README",
  "README.markdown",
  "**/README.markdown",
  "LICENSE",
  "**/LICENSE",
  "LICENSE.md",
  "**/LICENSE.md",
  "LICENSE.txt",
  "**/LICENSE.txt",
  ".gitignore",
  ".gitattributes",
  LOCKFILE_NAME,
];

export async function apply({
  source,
  target,
  dryRun,
  verbose,
  force,
  include,
  exclude,
  agents,
}) {
  if (!agents || agents.length === 0) {
    throw new Error("apply: no agents selected.");
  }

  const resolved = await resolveSource(source);
  const { dir: sourceDir, cleanup, kind, ref, commit } = resolved;

  try {
    ensureTargetDir(target, dryRun);

    const includeRes = include.map(globToRegex);
    const excludeRes = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegex);

    const plan = planFiles({
      files: walk(sourceDir),
      agents,
      includeRes,
      excludeRes,
    });

    console.log(
      `source:  ${source}${ref ? ` @${ref}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}`
    );
    console.log(`target:  ${target}`);
    console.log(`agents:  ${agents.map((a) => a.id).join(", ")}`);
    if (dryRun) console.log("mode:    dry-run (no changes will be made)");
    console.log("");

    const stats = { copied: 0, skipped: 0, excluded: plan.excluded };
    const installed = [];

    for (const action of plan.actions) {
      const dst = path.join(target, action.relDst);
      const src = path.join(sourceDir, action.relSrc);
      const dstDir = path.dirname(dst);

      if (fs.existsSync(dst) && !force) {
        stats.skipped++;
        log(`  skip      ${action.relDst}  (already exists)`);
        continue;
      }

      if (!fs.existsSync(dstDir)) {
        if (dryRun) {
          if (verbose) log(`  mkdir     ${path.relative(target, dstDir) || "."}/`);
        } else {
          fs.mkdirSync(dstDir, { recursive: true });
        }
      }

      const label = action.relDst === action.relSrc ? "copy" : "render";
      const suffix = action.relDst !== action.relSrc ? `  (from ${action.relSrc})` : "";
      if (!dryRun) {
        fs.copyFileSync(src, dst);
      }
      log(`  ${label.padEnd(9)} ${action.relDst}${suffix}`);
      stats.copied++;

      installed.push({
        path: toPosix(action.relDst),
        fromSource: toPosix(action.relSrc),
        sha256: dryRun ? hashBuffer(fs.readFileSync(src)) : hashFile(dst),
        agent: action.agent ?? null,
      });
    }

    if (verbose) {
      for (const ex of plan.excludedPaths) log(`  excluded  ${ex}`);
    }

    if (!dryRun) {
      const existing = readLockfile(target);
      const sources = existing?.sources ? [...existing.sources] : [];
      const key = sourceKey(source);
      const idx = sources.findIndex((s) => sourceKey(s.source) === key);
      const prev = idx >= 0 ? sources[idx] : null;
      const now = new Date().toISOString();
      const entry = {
        source,
        kind,
        ref: ref ?? null,
        commit: commit ?? null,
        installedAt: prev?.installedAt ?? now,
        updatedAt: now,
        agents: mergeAgents(prev?.agents ?? [], agents.map((a) => a.id)),
        files: mergeFiles(prev?.files ?? [], installed),
      };
      if (idx >= 0) sources[idx] = entry;
      else sources.push(entry);
      writeLockfile(target, { sources });
    }

    console.log("");
    console.log(
      `${dryRun ? "[dry-run] " : ""}done. copied: ${stats.copied}, skipped: ${stats.skipped}, excluded: ${stats.excluded}`
    );
  } finally {
    await cleanup();
  }
}

export function planFiles({ files, agents, includeRes, excludeRes }) {
  const actions = [];
  const excludedPaths = [];
  let excluded = 0;
  const dstSet = new Map();
  const selectedIds = new Set(agents.map((a) => a.id));

  for (const rel of files) {
    const posix = toPosix(rel);

    if (excludeRes.some((re) => re.test(posix))) {
      excluded++;
      excludedPaths.push(posix);
      continue;
    }
    if (includeRes.length > 0 && !includeRes.some((re) => re.test(posix))) {
      excluded++;
      excludedPaths.push(posix);
      continue;
    }

    const owner = scopeDirOwner(posix);
    if (owner) {
      if (!selectedIds.has(owner.id)) {
        excluded++;
        excludedPaths.push(posix);
        continue;
      }
      if (dstSet.has(posix)) continue;
      dstSet.set(posix, posix);
      actions.push({ relSrc: rel, relDst: rel, agent: owner.id });
      continue;
    }

    if (isRuleFile(posix)) {
      const dir = posix.includes("/") ? posix.slice(0, posix.lastIndexOf("/") + 1) : "";
      for (const agent of agents) {
        const relDst = dir + agent.filename;
        if (dstSet.has(relDst)) {
          const prev = dstSet.get(relDst);
          if (prev !== posix) {
            console.warn(
              `  warn      ${relDst} written by ${prev}; ignoring duplicate from ${posix}`
            );
          }
          continue;
        }
        dstSet.set(relDst, posix);
        actions.push({ relSrc: rel, relDst, agent: agent.id });
      }
    } else {
      if (dstSet.has(posix)) continue;
      dstSet.set(posix, posix);
      actions.push({ relSrc: rel, relDst: rel, agent: null });
    }
  }

  return { actions, excluded, excludedPaths };
}

function ensureTargetDir(target, dryRun) {
  if (!fs.existsSync(target)) {
    if (dryRun) {
      log(`[dry-run] would create target directory ${target}`);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
  } else if (!fs.statSync(target).isDirectory()) {
    throw new Error(`target exists but is not a directory: ${target}`);
  }
}

function mergeAgents(prev, next) {
  return [...new Set([...prev, ...next])];
}

function mergeFiles(prev, next) {
  const byPath = new Map(prev.map((f) => [f.path, f]));
  for (const f of next) byPath.set(f.path, f);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      } else if (entry.isSymbolicLink()) {
        // rules repos may symlink rule files (e.g. .claude/rules/* -> a
        // canonical CLAUDE.md); include them when they resolve to a file.
        // copyFileSync follows the link, so the target gets a regular file.
        try {
          if (fs.statSync(path.join(abs, entry.name)).isFile()) {
            out.push(childRel);
          }
        } catch {
          // dangling symlink — skip
        }
      }
    }
  }
  return out.sort();
}

function log(msg) {
  console.log(msg);
}

export { DEFAULT_EXCLUDES };

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
  findSourceEntry,
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
  preserveSymlinks = null,
}) {
  if (!agents || agents.length === 0) {
    throw new Error("apply: no agents selected.");
  }

  const existingLock = readLockfile(target);
  const prevSourceEntry = existingLock ? findSourceEntry(existingLock, source) : null;
  // Explicit flag wins; otherwise inherit what this source was installed with.
  const preserve = preserveSymlinks ?? prevSourceEntry?.preserveSymlinks ?? false;

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
    const bySrc = actionsBySrc(plan.actions);

    console.log(
      `source:  ${source}${ref ? ` @${ref}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}`
    );
    console.log(`target:  ${target}`);
    console.log(`agents:  ${agents.map((a) => a.id).join(", ")}`);
    if (preserve) console.log("mode:    preserving source symlinks");
    if (dryRun) console.log("mode:    dry-run (no changes will be made)");
    console.log("");

    const stats = { copied: 0, linked: 0, skipped: 0, excluded: plan.excluded };
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

      const linkDst = preserve
        ? linkDestinationFor({ sourceDir, bySrc, action })
        : null;

      if (linkDst) {
        const wrote = dryRun
          ? true
          : writeSymlink(target, dst, linkDst);
        if (wrote) {
          log(`  link      ${action.relDst}  -> ${linkDst}`);
          stats.linked++;
          installed.push({
            path: toPosix(action.relDst),
            fromSource: toPosix(action.relSrc),
            sha256: hashBuffer(fs.readFileSync(src)),
            agent: action.agent ?? null,
            symlinkTo: linkDst,
          });
          continue;
        }
        // symlink creation failed (e.g. unprivileged Windows) — fall through to copy.
        console.warn(`  warn      could not symlink ${action.relDst}; copying instead`);
      }

      const label = action.relDst === action.relSrc ? "copy" : "render";
      const suffix = action.relDst !== action.relSrc ? `  (from ${action.relSrc})` : "";
      if (!dryRun) {
        removeIfSymlink(dst);
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
        preserveSymlinks: preserve,
        agents: mergeAgents(prev?.agents ?? [], agents.map((a) => a.id)),
        files: mergeFiles(prev?.files ?? [], installed),
      };
      if (idx >= 0) sources[idx] = entry;
      else sources.push(entry);
      writeLockfile(target, { sources });
    }

    console.log("");
    console.log(
      `${dryRun ? "[dry-run] " : ""}done. copied: ${stats.copied}${preserve ? `, linked: ${stats.linked}` : ""}, skipped: ${stats.skipped}, excluded: ${stats.excluded}`
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

// ---- symlink preservation -------------------------------------------------

export function actionsBySrc(actions) {
  const map = new Map();
  for (const a of actions) {
    const key = toPosix(a.relSrc);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  return map;
}

// If the source file behind `action` is a symlink whose target is inside the
// source tree AND that target is also being installed, return the installed
// destination (project-relative posix path) the link should point at.
// Returns null when the file isn't a link, the link escapes the source tree,
// or its target isn't part of this install (excluded, other agents only) —
// callers fall back to copying content, which matches pre-flag behavior.
export function linkDestinationFor({ sourceDir, bySrc, action }) {
  const abs = path.join(sourceDir, action.relSrc);
  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!lst.isSymbolicLink()) return null;

  const resolvedTarget = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
  const targetRel = path.relative(sourceDir, resolvedTarget);
  if (targetRel.startsWith("..") || path.isAbsolute(targetRel)) return null;

  const candidates = bySrc.get(toPosix(targetRel)) ?? [];
  // Prefer the target rendered for the same agent, then a verbatim install.
  const sameAgent = candidates.find((c) => c.agent === action.agent);
  const verbatim = candidates.find((c) => toPosix(c.relDst) === toPosix(targetRel));
  const chosen = sameAgent ?? verbatim ?? null;
  if (!chosen) return null;
  const relDst = toPosix(chosen.relDst);
  return relDst === toPosix(action.relDst) ? null : relDst; // never self-link
}

// Create a relative symlink at dst pointing to linkDst (project-relative).
// Returns false when the platform refuses (e.g. unprivileged Windows).
export function writeSymlink(target, dst, linkDst) {
  const linkValue = path.relative(path.dirname(dst), path.join(target, linkDst));
  try {
    fs.rmSync(dst, { force: true });
    fs.symlinkSync(linkValue, dst);
    return true;
  } catch {
    return false;
  }
}

export function expectedLinkValue(target, dst, linkDst) {
  return path.relative(path.dirname(dst), path.join(target, linkDst));
}

export function isSymlinkAt(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Copying onto a path that is currently a symlink would write THROUGH the
// link and overwrite the canonical file it points at — remove the link first.
export function removeIfSymlink(p) {
  if (isSymlinkAt(p)) fs.rmSync(p, { force: true });
}

export { DEFAULT_EXCLUDES };

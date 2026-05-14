import fs from "node:fs";
import path from "node:path";
import { resolveSource } from "./resolve-source.js";
import { globToRegex, toPosix } from "./glob.js";
import { agentById, isRuleFile } from "./agents.js";
import {
  hashFile,
  readLockfile,
  writeLockfile,
  LOCKFILE_NAME,
} from "./lockfile.js";
import { DEFAULT_EXCLUDES, planFiles, walk } from "./apply.js";

export async function update({
  target,
  dryRun,
  verbose,
  force,
  prune,
  ref: refOverride,
  source: sourceOverride,
  include,
  exclude,
}) {
  const lock = readLockfile(target);
  if (!lock) {
    throw new Error(
      `no lockfile (${LOCKFILE_NAME}) in ${target}. run 'apply-agent-rules apply <source>' first.`
    );
  }

  const source = sourceOverride ?? applyRefOverride(lock.source, refOverride);
  const agents = (lock.agents ?? []).map(agentById).filter(Boolean);
  if (agents.length === 0) {
    throw new Error(
      `lockfile has no agents recorded. re-run 'apply-agent-rules apply' to reset.`
    );
  }

  const resolved = await resolveSource(source);
  const { dir: sourceDir, cleanup, kind, ref, commit } = resolved;

  try {
    const includeRes = include.map(globToRegex);
    const excludeRes = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegex);

    const plan = planFiles({
      files: walk(sourceDir),
      agents,
      includeRes,
      excludeRes,
    });

    const lockByPath = new Map((lock.files ?? []).map((f) => [f.path, f]));
    const planByPath = new Map(plan.actions.map((a) => [toPosix(a.relDst), a]));

    console.log(
      `source:  ${source}${ref ? ` @${ref}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}`
    );
    console.log(`target:  ${target}`);
    console.log(`agents:  ${agents.map((a) => a.id).join(", ")}`);
    if (dryRun) console.log("mode:    dry-run (no changes will be made)");
    console.log("");

    const stats = { written: 0, drift: 0, pruned: 0, unchanged: 0, added: 0 };
    const newFiles = [];

    for (const [relDst, action] of planByPath) {
      const dst = path.join(target, action.relDst);
      const src = path.join(sourceDir, action.relSrc);
      const dstDir = path.dirname(dst);
      const prevEntry = lockByPath.get(relDst);

      const localHash = fs.existsSync(dst) ? hashFile(dst) : null;
      const sourceHash = hashFile(src);

      if (localHash === sourceHash) {
        stats.unchanged++;
        if (verbose) log(`  unchanged ${relDst}`);
        newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, sourceHash) });
        continue;
      }

      if (localHash && prevEntry && prevEntry.sha256 !== localHash && !force) {
        stats.drift++;
        log(`  drift     ${relDst}  (locally modified, skipping; use --force to overwrite)`);
        newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, prevEntry.sha256) });
        continue;
      }

      if (!fs.existsSync(dstDir)) {
        if (!dryRun) fs.mkdirSync(dstDir, { recursive: true });
      }

      if (!dryRun) fs.copyFileSync(src, dst);

      if (!prevEntry) {
        stats.added++;
        log(`  add       ${relDst}`);
      } else {
        stats.written++;
        log(`  update    ${relDst}`);
      }
      newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, sourceHash) });
    }

    if (prune) {
      for (const [relDst, prevEntry] of lockByPath) {
        if (planByPath.has(relDst)) continue;
        const dst = path.join(target, relDst);
        const localHash = fs.existsSync(dst) ? hashFile(dst) : null;

        if (!localHash) {
          stats.pruned++;
          if (verbose) log(`  prune     ${relDst}  (already gone)`);
          continue;
        }
        if (localHash !== prevEntry.sha256 && !force) {
          log(`  keep      ${relDst}  (locally modified; --force to prune anyway)`);
          newFiles.push(prevEntry);
          continue;
        }
        if (!dryRun) {
          fs.rmSync(dst, { force: true });
          tryRemoveEmptyDirs(path.dirname(dst), target);
        }
        stats.pruned++;
        log(`  prune     ${relDst}`);
      }
    } else {
      for (const [relDst, prevEntry] of lockByPath) {
        if (!planByPath.has(relDst)) newFiles.push(prevEntry);
      }
    }

    if (!dryRun) {
      writeLockfile(target, {
        source: lock.source,
        kind,
        ref: ref ?? lock.ref ?? null,
        commit: commit ?? null,
        installedAt: lock.installedAt,
        updatedAt: new Date().toISOString(),
        agents: lock.agents,
        files: newFiles.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }

    console.log("");
    console.log(
      `${dryRun ? "[dry-run] " : ""}done. updated: ${stats.written}, added: ${stats.added}, unchanged: ${stats.unchanged}, drift: ${stats.drift}, pruned: ${stats.pruned}`
    );
  } finally {
    await cleanup();
  }
}

function buildEntry(action, sha256) {
  return {
    path: toPosix(action.relDst),
    fromSource: toPosix(action.relSrc),
    sha256,
  };
}

function applyRefOverride(source, override) {
  if (!override) return source;
  // Strip an existing @ref or #ref, then append the new ref.
  // Treat the FIRST '@' only if it follows a "/" (avoid stripping git ssh user@host).
  const hashIdx = source.indexOf("#");
  const slashIdx = source.indexOf("/");
  let base = source;
  if (hashIdx !== -1) {
    base = source.slice(0, hashIdx);
  } else {
    const atIdx = source.lastIndexOf("@");
    if (atIdx !== -1 && atIdx > slashIdx) base = source.slice(0, atIdx);
  }
  return `${base}@${override}`;
}

function log(msg) {
  console.log(msg);
}

function tryRemoveEmptyDirs(dir, stopAt) {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

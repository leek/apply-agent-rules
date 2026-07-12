import fs from "node:fs";
import path from "node:path";
import { resolveSource } from "./resolve-source.js";
import { globToRegex, toPosix } from "./glob.js";
import { agentById } from "./agents.js";
import {
  hashFile,
  readLockfile,
  writeLockfile,
  findSourceEntry,
  sourceKey,
  LOCKFILE_NAME,
} from "./lockfile.js";
import {
  DEFAULT_EXCLUDES,
  planFiles,
  walk,
  actionsBySrc,
  linkDestinationFor,
  writeSymlink,
  expectedLinkValue,
  isSymlinkAt,
  removeIfSymlink,
} from "./apply.js";

export async function update({
  target,
  dryRun,
  verbose,
  force,
  prune,
  ref: refOverride,
  source: sourceArg,
  include,
  exclude,
  agents: agentsOverride,
  preserveSymlinks: preserveOverride = null,
}) {
  const lock = readLockfile(target);
  if (!lock || !lock.sources || lock.sources.length === 0) {
    throw new Error(
      `no lockfile (${LOCKFILE_NAME}) in ${target}. run 'apply-agent-rules apply <source>' first.`
    );
  }

  let entry;
  if (sourceArg) {
    entry = findSourceEntry(lock, sourceArg);
    if (!entry) {
      const known = lock.sources.map((s) => s.source).join(", ");
      throw new Error(
        `source "${sourceArg}" not found in lockfile. known sources: ${known}`
      );
    }
  } else if (lock.sources.length === 1) {
    entry = lock.sources[0];
  } else {
    const known = lock.sources.map((s) => s.source).join(", ");
    throw new Error(
      `multiple sources in lockfile (${known}). pass the source as a positional arg or via --source.`
    );
  }

  const source = applyRefOverride(entry.source, refOverride);
  const agents =
    agentsOverride && agentsOverride.length > 0
      ? agentsOverride
      : (entry.agents ?? []).map(agentById).filter(Boolean);
  if (agents.length === 0) {
    throw new Error(
      `lockfile entry for ${entry.source} has no agents recorded. re-run 'apply-agent-rules apply' to reset.`
    );
  }
  const agentIds = agents.map((a) => a.id);
  const agentsChanged =
    agentsOverride &&
    JSON.stringify([...agentIds].sort()) !==
      JSON.stringify([...(entry.agents ?? [])].sort());

  // Explicit flag wins; otherwise use what this source was installed with.
  const preserve = preserveOverride ?? entry.preserveSymlinks ?? false;

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
    const bySrc = actionsBySrc(plan.actions);

    const lockByPath = new Map((entry.files ?? []).map((f) => [f.path, f]));
    const planByPath = new Map(plan.actions.map((a) => [toPosix(a.relDst), a]));

    console.log(
      `source:  ${source}${ref ? ` @${ref}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}`
    );
    console.log(`target:  ${target}`);
    console.log(`agents:  ${agents.map((a) => a.id).join(", ")}`);
    if (preserve) console.log("mode:    preserving source symlinks");
    if (dryRun) console.log("mode:    dry-run (no changes will be made)");
    console.log("");

    const stats = { written: 0, drift: 0, pruned: 0, unchanged: 0, added: 0 };
    const newFiles = [];

    for (const [relDst, action] of planByPath) {
      const dst = path.join(target, action.relDst);
      const src = path.join(sourceDir, action.relSrc);
      const dstDir = path.dirname(dst);
      const prevEntry = lockByPath.get(relDst);

      const linkDst = preserve
        ? linkDestinationFor({ sourceDir, bySrc, action })
        : null;
      const isLink = isSymlinkAt(dst);
      const wasOurLink = Boolean(prevEntry?.symlinkTo);
      const localHash = safeHashFile(dst); // null when missing or dangling
      const sourceHash = hashFile(src);

      if (linkDst) {
        const correctLink =
          isLink && fs.readlinkSync(dst) === expectedLinkValue(target, dst, linkDst);
        if (correctLink && localHash === sourceHash) {
          stats.unchanged++;
          if (verbose) log(`  unchanged ${relDst}`);
          newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, sourceHash, linkDst) });
          continue;
        }
        if (!isLink && localHash && prevEntry && prevEntry.sha256 !== localHash && !force) {
          stats.drift++;
          log(`  drift     ${relDst}  (locally modified, skipping; use --force to overwrite)`);
          newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, prevEntry.sha256) });
          continue;
        }
        if (!fs.existsSync(dstDir)) {
          if (!dryRun) fs.mkdirSync(dstDir, { recursive: true });
        }
        const wrote = dryRun ? true : writeSymlink(target, dst, linkDst);
        if (wrote) {
          if (!prevEntry) {
            stats.added++;
            log(`  add       ${relDst}  -> ${linkDst}`);
          } else {
            stats.written++;
            log(`  link      ${relDst}  -> ${linkDst}`);
          }
          newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, sourceHash, linkDst) });
          continue;
        }
        console.warn(`  warn      could not symlink ${relDst}; copying instead`);
        // fall through to the copy path below
      }

      // A link this tool created that should now be a copy (mode turned off,
      // or the source stopped symlinking it) is materialized even when the
      // content already matches. User-made symlinks are left alone.
      const mustMaterialize = wasOurLink && isLink && !linkDst;

      if (localHash === sourceHash && !mustMaterialize) {
        stats.unchanged++;
        if (verbose) log(`  unchanged ${relDst}`);
        newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, sourceHash) });
        continue;
      }

      const ourLinkInPlace = wasOurLink && isLink;
      if (localHash && prevEntry && prevEntry.sha256 !== localHash && !force && !ourLinkInPlace) {
        stats.drift++;
        log(`  drift     ${relDst}  (locally modified, skipping; use --force to overwrite)`);
        newFiles.push({ agent: action.agent ?? null, ...buildEntry(action, prevEntry.sha256) });
        continue;
      }

      if (!fs.existsSync(dstDir)) {
        if (!dryRun) fs.mkdirSync(dstDir, { recursive: true });
      }

      if (!dryRun) {
        removeIfSymlink(dst);
        fs.copyFileSync(src, dst);
      }

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
      const ownedByOtherSources = collectOwnedPaths(lock, entry);
      for (const [relDst, prevEntry] of lockByPath) {
        if (planByPath.has(relDst)) continue;
        if (ownedByOtherSources.has(relDst)) {
          if (verbose) log(`  keep      ${relDst}  (owned by another source)`);
          continue;
        }
        const dst = path.join(target, relDst);
        // lstat-based presence so dangling symlinks still get cleaned up.
        const present = isSymlinkAt(dst) || fs.existsSync(dst);
        const localHash = safeHashFile(dst);

        if (!present) {
          stats.pruned++;
          if (verbose) log(`  prune     ${relDst}  (already gone)`);
          continue;
        }
        // Links this tool created never count as local modifications — edits
        // land in the canonical file the link points at, which is judged on
        // its own path.
        const ourLink = Boolean(prevEntry.symlinkTo) && isSymlinkAt(dst);
        if (localHash && localHash !== prevEntry.sha256 && !force && !ourLink) {
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
      const sources = lock.sources.map((s) => s);
      const idx = sources.findIndex(
        (s) => sourceKey(s.source) === sourceKey(entry.source)
      );
      const updated = {
        source: entry.source,
        kind,
        ref: ref ?? entry.ref ?? null,
        commit: commit ?? null,
        installedAt: entry.installedAt,
        updatedAt: new Date().toISOString(),
        preserveSymlinks: preserve,
        agents: agentsChanged ? agentIds : entry.agents,
        files: newFiles.sort((a, b) => a.path.localeCompare(b.path)),
      };
      sources[idx] = updated;
      writeLockfile(target, { sources });
    }

    console.log("");
    console.log(
      `${dryRun ? "[dry-run] " : ""}done. updated: ${stats.written}, added: ${stats.added}, unchanged: ${stats.unchanged}, drift: ${stats.drift}, pruned: ${stats.pruned}`
    );
  } finally {
    await cleanup();
  }
}

function collectOwnedPaths(lock, currentEntry) {
  const out = new Set();
  const currentKey = sourceKey(currentEntry.source);
  for (const s of lock.sources) {
    if (sourceKey(s.source) === currentKey) continue;
    for (const f of s.files ?? []) out.add(f.path);
  }
  return out;
}

function buildEntry(action, sha256, symlinkTo = null) {
  return {
    path: toPosix(action.relDst),
    fromSource: toPosix(action.relSrc),
    sha256,
    ...(symlinkTo ? { symlinkTo } : {}),
  };
}

function safeHashFile(p) {
  try {
    return hashFile(p);
  } catch {
    return null;
  }
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

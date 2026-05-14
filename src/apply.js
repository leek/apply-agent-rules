import fs from "node:fs";
import path from "node:path";
import { resolveSource } from "./resolve-source.js";
import { globToRegex, toPosix } from "./glob.js";

const DEFAULT_EXCLUDES = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".DS_Store",
  "**/.DS_Store",
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  ".gitignore",
  ".gitattributes",
];

export async function apply({ source, target, dryRun, verbose, force, include, exclude }) {
  const { dir: sourceDir, cleanup } = await resolveSource(source);

  try {
    if (!fs.existsSync(target)) {
      if (dryRun) {
        log(`[dry-run] would create target directory ${target}`);
      } else {
        fs.mkdirSync(target, { recursive: true });
      }
    } else if (!fs.statSync(target).isDirectory()) {
      throw new Error(`target exists but is not a directory: ${target}`);
    }

    const includeRes = include.map(globToRegex);
    const excludeRes = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegex);

    const stats = { copied: 0, skipped: 0, excluded: 0, dirsCreated: 0 };
    const files = walk(sourceDir);

    console.log(`source: ${source}`);
    console.log(`target: ${target}`);
    if (dryRun) console.log("mode:   dry-run (no changes will be made)");
    console.log("");

    for (const rel of files) {
      const posix = toPosix(rel);

      if (excludeRes.some((re) => re.test(posix))) {
        stats.excluded++;
        if (verbose) log(`  excluded  ${posix}`);
        continue;
      }
      if (includeRes.length > 0 && !includeRes.some((re) => re.test(posix))) {
        stats.excluded++;
        if (verbose) log(`  filtered  ${posix}`);
        continue;
      }

      const src = path.join(sourceDir, rel);
      const dst = path.join(target, rel);
      const dstDir = path.dirname(dst);

      if (fs.existsSync(dst) && !force) {
        stats.skipped++;
        log(`  skip      ${posix}  (already exists)`);
        continue;
      }

      if (!fs.existsSync(dstDir)) {
        if (dryRun) {
          if (verbose) log(`  mkdir     ${path.relative(target, dstDir) || "."}/`);
        } else {
          fs.mkdirSync(dstDir, { recursive: true });
        }
        stats.dirsCreated++;
      }

      if (dryRun) {
        log(`  copy      ${posix}`);
      } else {
        fs.copyFileSync(src, dst);
        log(`  copy      ${posix}`);
      }
      stats.copied++;
    }

    console.log("");
    console.log(
      `${dryRun ? "[dry-run] " : ""}done. ` +
        `copied: ${stats.copied}, skipped: ${stats.skipped}, excluded: ${stats.excluded}`
    );
  } finally {
    await cleanup();
  }
}

function walk(root) {
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
      }
      // symlinks intentionally skipped to keep this safe
    }
  }
  return out.sort();
}

function log(msg) {
  console.log(msg);
}

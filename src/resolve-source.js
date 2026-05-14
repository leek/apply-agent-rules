import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const GITHUB_SHORTHAND = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/;

/**
 * Resolve a source string to a local directory containing the rules tree.
 * Returns { dir, cleanup }. Caller must call cleanup() when done.
 */
export async function resolveSource(source) {
  // Local path - either absolute, or starts with ./ or ../, or is an existing dir
  if (
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("/") ||
    source.startsWith("~")
  ) {
    const expanded = source.startsWith("~")
      ? path.join(os.homedir(), source.slice(1))
      : source;
    const abs = path.resolve(expanded);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`local source not found or not a directory: ${abs}`);
    }
    return { dir: abs, cleanup: async () => {} };
  }

  // owner/repo or owner/repo@ref -> github url
  const sh = source.match(GITHUB_SHORTHAND);
  let cloneUrl;
  let ref;
  if (sh) {
    cloneUrl = `https://github.com/${sh[1]}/${sh[2]}.git`;
    ref = sh[3];
  } else if (/^https?:\/\//.test(source) || /^git@/.test(source) || source.endsWith(".git")) {
    // Strip trailing ".git" only when re-parsing for #ref support
    const [base, fragment] = source.split("#");
    cloneUrl = base.endsWith(".git") ? base : `${base}.git`;
    ref = fragment;
  } else {
    throw new Error(
      `cannot interpret source "${source}". use owner/repo, a git url, or a local path.`
    );
  }

  return cloneRepo(cloneUrl, ref);
}

function cloneRepo(cloneUrl, ref) {
  ensureGit();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apply-agent-rules-"));
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, tmp);

  const result = spawnSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(
      `git clone failed for ${cloneUrl}${ref ? ` @${ref}` : ""}\n${stderr.trim()}`
    );
  }

  return {
    dir: tmp,
    cleanup: async () => {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function ensureGit() {
  const r = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (r.status !== 0) {
    throw new Error("git is required to clone remote sources but was not found on PATH.");
  }
}

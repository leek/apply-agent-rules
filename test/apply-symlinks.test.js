import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aar-apply-"));
}

function run(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
}

// Mirrors filament-agent-rules: .claude/skills/<name> is a directory symlink
// to .agents/skills/<name>.
function makeRepo() {
  const repo = tmpdir();
  fs.mkdirSync(path.join(repo, ".agents", "skills", "forms"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".agents", "skills", "forms", "SKILL.md"), "skill v1");
  fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  fs.symlinkSync("../../.agents/skills/forms", path.join(repo, ".claude", "skills", "forms"));
  return repo;
}

const SKILL = path.join(".claude", "skills", "forms", "SKILL.md");

test("default mode copies files from a symlinked directory", () => {
  const repo = makeRepo();
  const target = tmpdir();
  run("apply", repo, "--agents", "claude", "--target", target);
  const dst = path.join(target, SKILL);
  assert.equal(fs.lstatSync(dst).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(dst, "utf8"), "skill v1");
});

test("--preserve-symlinks links each file under a symlinked directory", () => {
  const repo = makeRepo();
  const target = tmpdir();
  run("apply", repo, "--agents", "claude", "--target", target, "--preserve-symlinks");
  const dst = path.join(target, SKILL);
  assert.equal(fs.lstatSync(path.dirname(dst)).isSymbolicLink(), false);
  assert.equal(fs.readlinkSync(dst), "../../../.agents/skills/forms/SKILL.md");
  assert.equal(fs.readFileSync(dst, "utf8"), "skill v1");

  // update: links stay unchanged, then follow a source content change
  assert.match(run("update", "--target", target, "-v"), /unchanged .claude\/skills\/forms\/SKILL.md/);
  fs.writeFileSync(path.join(repo, ".agents", "skills", "forms", "SKILL.md"), "skill v2");
  run("update", "--target", target);
  assert.equal(fs.lstatSync(dst).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(dst, "utf8"), "skill v2");
});

test("update --preserve-symlinks converts copies from an earlier default install", () => {
  const repo = makeRepo();
  const target = tmpdir();
  run("apply", repo, "--agents", "claude", "--target", target);
  run("update", "--target", target, "--preserve-symlinks");
  const dst = path.join(target, SKILL);
  assert.equal(fs.lstatSync(dst).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(dst, "utf8"), "skill v1");
});

// The target already links .claude/skills/forms to .agents/skills/forms (as
// streamaba does), so .claude/skills/forms/SKILL.md IS the canonical file.
function linkTargetSkillDir(target) {
  fs.mkdirSync(path.join(target, ".agents", "skills", "forms"), { recursive: true });
  fs.mkdirSync(path.join(target, ".claude", "skills"), { recursive: true });
  fs.symlinkSync("../../.agents/skills/forms", path.join(target, ".claude", "skills", "forms"));
}

const CANONICAL = path.join(".agents", "skills", "forms", "SKILL.md");

test("--preserve-symlinks never links a file to itself through a target directory link", () => {
  const repo = makeRepo();
  const target = tmpdir();
  linkTargetSkillDir(target);
  run("apply", repo, "--agents", "claude", "--target", target, "--preserve-symlinks");
  const canonical = path.join(target, CANONICAL);
  assert.equal(fs.lstatSync(canonical).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(canonical, "utf8"), "skill v1");

  fs.writeFileSync(path.join(repo, ".agents", "skills", "forms", "SKILL.md"), "skill v2");
  run("update", "--target", target);
  assert.equal(fs.lstatSync(canonical).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(canonical, "utf8"), "skill v2");
});

test("update repairs a self-referencing link an earlier version wrote", () => {
  const repo = makeRepo();
  const target = tmpdir();
  linkTargetSkillDir(target);
  run("apply", repo, "--agents", "claude", "--target", target, "--preserve-symlinks");
  const canonical = path.join(target, CANONICAL);
  fs.rmSync(canonical);
  fs.symlinkSync("../../../.agents/skills/forms/SKILL.md", canonical);
  const lockPath = path.join(target, ".apply-agent-rules.lock.json");
  const lock = fs.readFileSync(lockPath, "utf8");
  fs.writeFileSync(
    lockPath,
    lock.replace(/("path": "\.claude\/skills\/forms\/SKILL\.md",[^}]*?"sha256": "[0-9a-f]+")/, '$1,\n          "symlinkTo": ".agents/skills/forms/SKILL.md"'),
  );
  run("update", "--target", target);
  assert.equal(fs.lstatSync(canonical).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(canonical, "utf8"), "skill v1");
});

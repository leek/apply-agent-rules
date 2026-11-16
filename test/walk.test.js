import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { walk } from "../src/apply.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aar-walk-"));
}

test("walk follows in-repo file symlinks and refuses ones escaping the repo", () => {
  const outside = tmpdir();
  const repo = tmpdir();
  fs.writeFileSync(path.join(outside, "secret"), "private key");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "CLAUDE.md"), "rules");
  fs.mkdirSync(path.join(repo, "rules"));

  // in-repo link: kept
  fs.symlinkSync("../docs/CLAUDE.md", path.join(repo, "rules", "inrepo.md"));
  // absolute link outside: refused
  fs.symlinkSync(path.join(outside, "secret"), path.join(repo, "rules", "abs.md"));
  // relative link climbing out: refused
  fs.symlinkSync(
    path.relative(path.join(repo, "rules"), path.join(outside, "secret")),
    path.join(repo, "rules", "rel.md")
  );
  // in-repo link to an in-repo link that escapes: refused (chain resolved)
  fs.symlinkSync("abs.md", path.join(repo, "rules", "chain.md"));
  // dangling and directory links: ignored
  fs.symlinkSync("missing.md", path.join(repo, "rules", "dangling.md"));
  fs.symlinkSync("../docs", path.join(repo, "rules", "dirlink"));

  const files = walk(repo).map((f) => f.split(path.sep).join("/"));
  assert.deepEqual(files, ["docs/CLAUDE.md", "rules/inrepo.md"]);
});

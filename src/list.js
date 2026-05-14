import { resolveSource } from "./resolve-source.js";
import { globToRegex, toPosix } from "./glob.js";
import { isRuleFile, scopeDirOwner, SCOPE_DIRS } from "./agents.js";
import { DEFAULT_EXCLUDES, walk } from "./apply.js";

export async function list({ source, agents, include, exclude, verbose }) {
  const resolved = await resolveSource(source);
  const { dir: sourceDir, cleanup, ref, commit } = resolved;

  try {
    const includeRes = include.map(globToRegex);
    const excludeRes = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegex);

    const rules = [];
    const assets = [];
    const scoped = new Map(); // agentId -> string[]
    const excluded = [];

    for (const rel of walk(sourceDir)) {
      const posix = toPosix(rel);
      if (excludeRes.some((re) => re.test(posix))) {
        excluded.push(posix);
        continue;
      }
      if (includeRes.length > 0 && !includeRes.some((re) => re.test(posix))) {
        excluded.push(posix);
        continue;
      }
      const owner = scopeDirOwner(posix);
      if (owner) {
        if (!scoped.has(owner.id)) scoped.set(owner.id, []);
        scoped.get(owner.id).push(posix);
        continue;
      }
      if (isRuleFile(posix)) rules.push(posix);
      else assets.push(posix);
    }

    console.log(
      `source:  ${source}${ref ? ` @${ref}` : ""}${commit ? ` (${commit.slice(0, 7)})` : ""}`
    );
    if (agents && agents.length > 0) {
      console.log(`agents:  ${agents.map((a) => a.id).join(", ")}`);
    } else {
      console.log("agents:  (none specified — pass --agents to preview rendered filenames)");
    }
    console.log("");

    if (rules.length > 0) {
      console.log(`rule files (${rules.length}):`);
      for (const r of rules) {
        console.log(`  ${r}`);
        if (agents && agents.length > 0) {
          const dir = r.includes("/") ? r.slice(0, r.lastIndexOf("/") + 1) : "";
          const dests = agents.map((a) => dir + a.filename).join(", ");
          console.log(`    -> ${dests}`);
        }
      }
      console.log("");
    }

    if (assets.length > 0) {
      console.log(`assets copied as-is (${assets.length}):`);
      for (const a of assets) console.log(`  ${a}`);
      console.log("");
    }

    if (scoped.size > 0) {
      const selectedIds = new Set((agents ?? []).map((a) => a.id));
      console.log(`agent-scoped files:`);
      for (const [id, paths] of scoped) {
        const tag =
          agents && agents.length > 0
            ? selectedIds.has(id)
              ? "(would copy)"
              : "(would skip — agent not selected)"
            : "";
        console.log(`  [${id}] ${paths.length} file(s) ${tag}`);
        for (const p of paths) console.log(`    ${p}`);
      }
      console.log("");
    }

    if (verbose && excluded.length > 0) {
      console.log(`excluded (${excluded.length}):`);
      for (const e of excluded) console.log(`  ${e}`);
      console.log("");
    }

    const scopedCount = [...scoped.values()].reduce((n, v) => n + v.length, 0);
    console.log(
      `summary: ${rules.length} rule file(s), ${assets.length} asset(s), ${scopedCount} agent-scoped, ${excluded.length} excluded`
    );
  } finally {
    await cleanup();
  }
}

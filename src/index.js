import path from "node:path";
import { apply } from "./apply.js";
import { update } from "./update.js";
import { list } from "./list.js";
import { AGENTS, parseAgentList } from "./agents.js";
import { selectAgents } from "./select.js";
import { readLockfile } from "./lockfile.js";

const USAGE = `apply-agent-rules - install agent rules (CLAUDE.md, AGENTS.md, etc.) into your project

USAGE
  npx apply-agent-rules apply  <source> [options]
  npx apply-agent-rules add    <source> [options]    (alias for apply)
  npx apply-agent-rules update [source]  [options]   (re-pull a recorded source; required if multiple are installed)
  npx apply-agent-rules list   <source> [options]    (preview a source, write nothing)

SOURCE
  owner/repo                       GitHub shorthand (defaults to default branch)
  owner/repo@ref                   GitHub shorthand at a branch, tag, or sha
  https://github.com/owner/repo    Full GitHub URL
  git@github.com:owner/repo.git    SSH git URL
  ./local/path                     Local path (no clone)

AGENTS
  ${AGENTS.map((a) => `${a.id.padEnd(10)} -> ${a.filename}`).join("\n  ")}

OPTIONS (apply)
  -t, --target <dir>     Target project root (default: cwd)
      --agents <list>    Comma list of agent ids, or 'all'. e.g. claude,codex
                         If omitted, prompts interactively (TTY only).
  -d, --dry-run          Print what would happen, copy nothing
  -v, --verbose          Print every file action
  -f, --force            Overwrite existing files (default: skip)
      --include <glob>   Only copy paths matching this glob (repeatable)
      --exclude <glob>   Skip paths matching this glob (repeatable)
  -h, --help             Show this help

OPTIONS (update)
  -t, --target <dir>     Target project root (default: cwd)
      --source <src>     Override source from lockfile
      --ref <ref>        Override ref (branch/tag/sha)
      --agents <list>    Replace the agent set in the lockfile. Files belonging
                         to dropped agents are pruned (use --no-prune to keep,
                         --force to drop locally-modified ones too).
      --no-prune         Don't delete files removed from source (default: prune)
  -d, --dry-run          Print what would happen, change nothing
  -v, --verbose          Print every file action
  -f, --force            Overwrite drift and prune locally-modified files
      --include <glob>   Only consider paths matching this glob (repeatable)
      --exclude <glob>   Skip paths matching this glob (repeatable)

OPTIONS (list)
  --agents <list>        Optional; if provided, preview rendered filenames
      --include <glob>   Only consider paths matching this glob (repeatable)
      --exclude <glob>   Skip paths matching this glob (repeatable)
  -v, --verbose          Also list excluded files

EXAMPLES
  npx apply-agent-rules apply leek/laravel-agent-rules --agents claude,codex
  npx apply-agent-rules apply leek/laravel-agent-rules@v1.2.0 --target ./my-app
  npx apply-agent-rules apply ./local-rules-repo --agents all --dry-run
  npx apply-agent-rules list  leek/laravel-agent-rules
  npx apply-agent-rules list  leek/laravel-agent-rules --agents gemini,codex
  npx apply-agent-rules update                                   # re-pull (single source)
  npx apply-agent-rules update leek/filament-agent-rules         # target one of several sources
  npx apply-agent-rules update leek/laravel-agent-rules --ref v2 # pin a source to a ref
  npx apply-agent-rules update --agents claude                   # drop other agents, prune their files
  npx apply-agent-rules update --no-prune --force                # overwrite drift, keep stale
`;

export async function run(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const [cmd, ...rest] = argv;

  if (cmd === "apply" || cmd === "add") {
    const opts = parseOpts(rest, { requireSource: true });
    const target = path.resolve(opts.target ?? process.cwd());
    const agents = opts.agentsRaw
      ? parseAgentList(opts.agentsRaw)
      : await selectAgents({ target, preselect: lockfileAgents(target) });
    if (agents.length === 0) throw new Error("no agents selected.");

    await apply({
      source: opts.source,
      target,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      force: opts.force,
      include: opts.include,
      exclude: opts.exclude,
      agents,
    });
    return;
  }

  if (cmd === "list" || cmd === "ls") {
    const opts = parseOpts(rest, { requireSource: true });
    const agents = opts.agentsRaw ? parseAgentList(opts.agentsRaw) : [];
    await list({
      source: opts.source,
      agents,
      include: opts.include,
      exclude: opts.exclude,
      verbose: opts.verbose,
    });
    return;
  }

  if (cmd === "update") {
    const opts = parseOpts(rest, { requireSource: false });
    const target = path.resolve(opts.target ?? process.cwd());
    const agents = opts.agentsRaw ? parseAgentList(opts.agentsRaw) : null;
    await update({
      target,
      dryRun: opts.dryRun,
      verbose: opts.verbose,
      force: opts.force,
      prune: opts.prune,
      ref: opts.refOverride,
      source: opts.sourceOverride ?? opts.source,
      include: opts.include,
      exclude: opts.exclude,
      agents,
    });
    return;
  }

  throw new Error(`unknown command "${cmd}". run with --help for usage.`);
}

function lockfileAgents(target) {
  try {
    const lock = readLockfile(target);
    if (!lock?.sources) return [];
    const ids = new Set();
    for (const s of lock.sources) for (const id of s.agents ?? []) ids.add(id);
    return [...ids];
  } catch {
    return [];
  }
}

function parseOpts(args, { requireSource }) {
  const opts = {
    source: null,
    target: null,
    dryRun: false,
    verbose: false,
    force: false,
    include: [],
    exclude: [],
    agentsRaw: null,
    prune: true,
    refOverride: null,
    sourceOverride: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-t":
      case "--target":
        opts.target = args[++i];
        break;
      case "-d":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "-f":
      case "--force":
        opts.force = true;
        break;
      case "--include":
        opts.include.push(args[++i]);
        break;
      case "--exclude":
        opts.exclude.push(args[++i]);
        break;
      case "--agents":
        opts.agentsRaw = args[++i];
        break;
      case "--prune":
        opts.prune = true;
        break;
      case "--no-prune":
        opts.prune = false;
        break;
      case "--ref":
        opts.refOverride = args[++i];
        break;
      case "--source":
        opts.sourceOverride = args[++i];
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`unknown flag "${a}"`);
        }
        if (opts.source) {
          throw new Error(`unexpected positional argument "${a}"`);
        }
        opts.source = a;
    }
  }
  if (requireSource && !opts.source) {
    throw new Error("missing <source>. run with --help for usage.");
  }
  return opts;
}

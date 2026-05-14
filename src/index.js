import path from "node:path";
import { apply } from "./apply.js";

const USAGE = `apply-agent-rules - copy a rules repo into your project tree

USAGE
  npx apply-agent-rules apply <source> [options]
  npx apply-agent-rules add   <source> [options]   (alias for apply)

SOURCE
  owner/repo                       GitHub shorthand (defaults to main branch)
  owner/repo@ref                   GitHub shorthand at a branch, tag, or sha
  https://github.com/owner/repo    Full GitHub URL
  git@github.com:owner/repo.git    SSH git URL
  https://gitlab.com/org/repo      Any git URL
  ./local/path                     Local path (no clone)

OPTIONS
  -t, --target <dir>     Target project root (default: cwd)
  -d, --dry-run          Print what would happen, copy nothing
  -v, --verbose          Print every file action
  -f, --force            Overwrite existing files (default: skip)
      --include <glob>   Only copy paths matching this glob (repeatable)
      --exclude <glob>   Skip paths matching this glob (repeatable)
                         Built-in excludes: .git, node_modules, .DS_Store, README.md, LICENSE
  -h, --help             Show this help

EXAMPLES
  npx apply-agent-rules apply leek/laravel-claude-rules
  npx apply-agent-rules apply leek/laravel-claude-rules@v1.2.0
  npx apply-agent-rules apply leek/laravel-claude-rules --target ./my-app --dry-run
  npx apply-agent-rules apply ./local-rules-repo --include 'app/**'
`;

export async function run(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }

  const [cmd, ...rest] = argv;
  if (cmd !== "apply" && cmd !== "add") {
    throw new Error(`unknown command "${cmd}". run with --help for usage.`);
  }

  const opts = parseOpts(rest);
  if (!opts.source) {
    throw new Error("missing <source>. run with --help for usage.");
  }

  await apply({
    source: opts.source,
    target: path.resolve(opts.target ?? process.cwd()),
    dryRun: opts.dryRun,
    verbose: opts.verbose,
    force: opts.force,
    include: opts.include,
    exclude: opts.exclude,
  });
}

function parseOpts(args) {
  const opts = {
    source: null,
    target: null,
    dryRun: false,
    verbose: false,
    force: false,
    include: [],
    exclude: [],
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
  return opts;
}

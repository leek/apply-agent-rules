# apply-agent-rules

Copy a rules repo (the tree of `CLAUDE.md`, `AGENTS.md`, or whatever your agent reads) into a target project, preserving directory structure. Works like `npx skills`: any git repo is a valid source.

## Usage

```bash
# GitHub shorthand
npx apply-agent-rules apply owner/repo

# Pinned to a branch, tag, or commit
npx apply-agent-rules apply owner/repo@v1.2.0

# Any git URL
npx apply-agent-rules apply https://gitlab.com/org/repo
npx apply-agent-rules apply git@github.com:owner/repo.git

# Local path (no clone)
npx apply-agent-rules apply ./my-local-rules

# Apply into a specific project root
npx apply-agent-rules apply owner/repo --target ./my-app

# See what would happen first
npx apply-agent-rules apply owner/repo --dry-run --verbose
```

## How it works

1. Resolves the source. Shorthand and URLs get a shallow `git clone` into a temp dir; local paths are used directly.
2. Walks every file in the source tree.
3. For each file, computes the same relative path inside `--target` (cwd by default), creates parent directories if missing, and copies the file.
4. **Existing files are skipped.** Use `--force` to overwrite.
5. Cleans up the temp clone.

So a source repo with:

```
app/Models/CLAUDE.md
app/config/CLAUDE.md
tests/Feature/CLAUDE.md
```

applied to `./my-app` produces:

```
my-app/app/Models/CLAUDE.md
my-app/app/config/CLAUDE.md
my-app/tests/Feature/CLAUDE.md
```

The target directories are created even if they don't exist in your project yet.

## Built-in excludes

These are always skipped: `.git/`, `node_modules/`, `.DS_Store`, `README.md`, `LICENSE`, `.gitignore`, `.gitattributes`. Add more with `--exclude '<glob>'` (repeatable).

## Options

| Flag | Description |
|---|---|
| `-t, --target <dir>` | Target project root (default: cwd) |
| `-d, --dry-run` | Show what would happen, copy nothing |
| `-v, --verbose` | Print every file action including excludes |
| `-f, --force` | Overwrite existing files |
| `--include <glob>` | Only copy paths matching glob (repeatable) |
| `--exclude <glob>` | Skip paths matching glob (repeatable) |

Globs support `*`, `**`, `?`, `[abc]`, and `{a,b,c}`. Paths are matched in posix form regardless of OS.

## Requirements

- Node 18+
- `git` on PATH (for remote sources only)

## Why not just `git clone && cp -r`?

You can. This tool adds: source-format flexibility (shorthand, refs, ssh, local), skip-if-exists semantics so re-applying preserves local customizations, include/exclude filters, and a dry-run.

## License

MIT

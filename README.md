# apply-agent-rules

Install agent rules into a target project, preserving directory structure. Works like `npx skills`: any git repo is a valid source.

Source repos keep a **single canonical rule file per directory** — either `CLAUDE.md` or `AGENTS.md`. At install time you pick which agents you want (`claude`, `codex`, `gemini`, `cursor`, `windsurf`, `cline`), and that one source file is rendered to each selected agent's expected filename in the same directory. No need to duplicate the same content under six names in your rules repo.

## Quick start

```bash
# Preview a source repo without writing anything
npx apply-agent-rules list leek/laravel-agent-rules --agents claude,codex

# Pick agents interactively, install into the current directory
npx apply-agent-rules apply leek/laravel-agent-rules

# Or pass agents non-interactively
npx apply-agent-rules apply leek/laravel-agent-rules --agents claude,codex

# Re-pull from the recorded source (preserves local edits, prunes deletes)
npx apply-agent-rules update
```

## How it works

1. Resolves the source: GitHub shorthand and git URLs are cloned shallowly into a temp dir; local paths are used directly.
2. Walks the source tree.
3. For each **canonical rule file** (basename `CLAUDE.md` or `AGENTS.md`), writes a copy at the same relative directory under each selected agent's expected filename.
4. All other files — assets, configs, even files literally named `GEMINI.md` or `.cursorrules` in the source — are copied verbatim with no renaming.
5. Existing files are skipped by default — re-running is safe. Use `--force` to overwrite.
6. Writes `.apply-agent-rules.lock.json` recording source, ref, commit, agents, and a SHA-256 for every installed file. `update` uses this to detect local edits and prune deletes.

Example. Source repo (author chose CLAUDE.md as their canonical name):

```
database/seeders/CLAUDE.md
app/Models/CLAUDE.md
app/Models/notes.txt
```

`apply leek/repo --agents codex --target ./my-app` produces:

```
my-app/database/seeders/AGENTS.md      (rendered from CLAUDE.md)
my-app/app/Models/AGENTS.md            (rendered from CLAUDE.md)
my-app/app/Models/notes.txt            (copied as-is)
my-app/.apply-agent-rules.lock.json
```

No `CLAUDE.md` files are written because the user only picked `codex`.

If two canonical rule files live in the same directory (`CLAUDE.md` and `AGENTS.md` side by side), `AGENTS.md` wins for any target filename you don't have a literal match for, and a warning prints. Pick one canonical name per directory.

## Agents

| id | canonical filename | scope dir |
|---|---|---|
| `claude` | `CLAUDE.md` | `.claude/` |
| `codex` | `AGENTS.md` | `.codex/` |
| `gemini` | `GEMINI.md` | — |
| `cursor` | `.cursorrules` | `.cursor/` |
| `windsurf` | `.windsurfrules` | — |
| `cline` | `.clinerules` | — |

When you run `apply` without `--agents`, an interactive prompt asks which to install for. Agents already present in your target tree (canonical filename or scope dir) are preselected.

### Agent scope directories

Some rule repos include agent-specific content that has no equivalent in other agents — e.g. `.claude/rules/*.md` (Claude Code's path-scoped rules), `.claude/commands/*.json`, `.cursor/rules/*.mdc`, `.codex/config.toml`. Anything inside a recognized scope dir is **copied verbatim only when that agent is selected**; otherwise the whole subtree is excluded. No renaming or mirroring happens for scoped files — they're already in the format that one agent expects.

Example. Source repo:

```
.claude/rules/php.md
.claude/commands.json
.cursor/rules/foo.mdc
app/Models/CLAUDE.md
```

`apply --agents claude` produces `.claude/...` + `app/Models/CLAUDE.md` (skips `.cursor/`). `apply --agents codex` produces `app/Models/AGENTS.md` only (skips both `.claude/` and `.cursor/`).

## Source formats

```bash
npx apply-agent-rules apply owner/repo                  # GitHub default branch
npx apply-agent-rules apply owner/repo@v1.2.0           # pinned ref
npx apply-agent-rules apply https://github.com/owner/repo
npx apply-agent-rules apply git@github.com:owner/repo.git
npx apply-agent-rules apply ./local-rules-repo
```

## `list`

Resolves a source (same formats as `apply`) and prints what it contains without writing anything. Useful for verifying a rules repo before installing.

```bash
npx apply-agent-rules list leek/laravel-agent-rules
npx apply-agent-rules list leek/laravel-agent-rules --agents codex,gemini
npx apply-agent-rules list ./local-rules --verbose            # also show excluded
```

If `--agents` is passed, each rule file is shown with the destination filenames it would render to.

## `update`

Re-resolves the source from the lockfile and reconciles:

- **Unmodified files** (local hash matches lockfile) → overwritten with the new source content.
- **Locally modified files** (drift) → skipped with a warning. Pass `--force` to overwrite.
- **Files removed from source** → deleted locally and emptied parent dirs cleaned up. Pass `--no-prune` to keep them.
- **New files in source** → added.
- **Ref pinning** → pass `--ref <branch|tag|sha>` to move; otherwise re-resolves the source string from the lockfile.

```bash
npx apply-agent-rules update                    # re-pull, default prune on
npx apply-agent-rules update --ref main         # change ref
npx apply-agent-rules update --agents claude    # drop other agents, prune their files
npx apply-agent-rules update --no-prune         # keep removed files
npx apply-agent-rules update --force            # overwrite drift, prune modified
npx apply-agent-rules update --dry-run -v       # preview everything
```

Pass `--agents` to **replace** the recorded agent set. Files for dropped agents (rendered files like `AGENTS.md`, plus their scope dirs like `.codex/`) are pruned on the same pass. Locally-modified files are kept unless you also pass `--force`. Pass `--no-prune` to keep them. Example: switch a project from `claude,codex` to `claude` only:

```bash
npx apply-agent-rules update --agents claude
```

## Options

### `apply` / `add`

| Flag | Description |
|---|---|
| `-t, --target <dir>` | Target project root (default: cwd) |
| `--agents <list>` | Comma list of agent ids, or `all`. Skips the interactive prompt. |
| `-d, --dry-run` | Show what would happen |
| `-v, --verbose` | Print every file action, including excludes |
| `-f, --force` | Overwrite existing files |
| `--include <glob>` | Only copy paths matching glob (repeatable) |
| `--exclude <glob>` | Skip paths matching glob (repeatable) |

### `update`

| Flag | Description |
|---|---|
| `-t, --target <dir>` | Target project root (default: cwd) |
| `--source <src>` | Override source from lockfile |
| `--ref <ref>` | Override the ref (branch/tag/sha) |
| `--agents <list>` | Replace the agent set; dropped agents' files are pruned |
| `--no-prune` | Don't delete files that vanished from source |
| `-f, --force` | Overwrite drift and prune locally-modified files |
| `-d, --dry-run`, `-v, --verbose` | as above |
| `--include`, `--exclude` | as above |

## Built-in excludes

Always skipped: `.git/`, `node_modules/`, `.DS_Store`, `**/README.md`, `**/README`, `**/LICENSE`, `**/LICENSE.md`, `**/LICENSE.txt`, `.gitignore`, `.gitattributes`, `.apply-agent-rules.lock.json`. READMEs and license files are treated as repo documentation and skipped at every level. Add more with `--exclude '<glob>'` (repeatable).

Globs support `*`, `**`, `?`, `[abc]`, and `{a,b,c}`. Paths are matched in posix form regardless of OS.

## Requirements

- Node 18+
- `git` on `PATH` (only for remote sources)

## Why not just `git clone && cp -r`?

You can. This adds:

- Source-format flexibility (GitHub shorthand, refs, ssh, local paths)
- Agent selection — one source-of-truth file, mirrored to N agents' filenames
- A lockfile, so `update` can detect drift, prune deletes, and refresh without clobbering your edits
- Skip-if-exists semantics so re-applying is safe
- Include/exclude filters, dry-run

## License

MIT

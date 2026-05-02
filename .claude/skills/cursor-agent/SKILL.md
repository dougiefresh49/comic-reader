---
name: cursor-agent
description: Delegate coding tasks to a Cursor agent running in headless mode. Use when parallelizing work — Cursor works in an isolated git worktree while Claude continues on the main branch. Good for well-specced, self-contained tasks like new scripts, migrations, or component builds.
---

## When to use

- Parallelizing independent coding tasks (Cursor works in a worktree, you keep working)
- Delegating well-specced tasks with clear inputs/outputs
- Batch code generation, refactoring, or analysis

## Prerequisites

- Cursor CLI installed (`curl https://cursor.com/install -fsS | bash`)
- Authenticated (`agent login` or `export CURSOR_API_KEY=...`)
- Current directory is a git repo (worktrees require git)

## Command syntax

```bash
# Basic headless execution (read-only analysis)
agent -p "your prompt here"

# With file modifications (required for code generation tasks)
agent -p --force "your prompt here"

# Full headless with trust (no confirmation prompts)
agent -p --force --trust "your prompt here"

# In an isolated git worktree (recommended for parallel work)
agent -p --force --trust -w <worktree-name> --worktree-base <branch> "your prompt"

# With specific model
agent -p --force --trust --model sonnet-4 "your prompt"
```

## Key flags

| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode (required for headless) |
| `--force` / `--yolo` | Allow file modifications without confirmation |
| `--trust` | Trust workspace without prompting (headless only) |
| `-w, --worktree [name]` | Run in isolated git worktree at `~/.cursor/worktrees/<repo>/<name>` |
| `--worktree-base <branch>` | Branch to base worktree on (default: current HEAD) |
| `--output-format <fmt>` | `text` (default), `json` (structured), `stream-json` (progress) |
| `--stream-partial-output` | Stream incremental deltas (with `stream-json`) |
| `--model <model>` | Model override (e.g., `gpt-5`, `sonnet-4`, `sonnet-4-thinking`) |
| `--mode <mode>` | `plan` (read-only planning) or `ask` (Q&A, no edits) |
| `--approve-mcps` | Auto-approve MCP servers |

## Workflow: delegate task to Cursor in a worktree

### 1. Write a task spec

Write a clear, self-contained spec file (e.g., `.cursor-task.md`) that includes:
- What to build (concrete deliverables)
- Files to create and modify
- Files NOT to modify (avoid merge conflicts with your parallel work)
- Existing patterns to follow (reference specific files)
- How to verify (e.g., `pnpm typecheck`)

### 2. Launch Cursor in background

```bash
agent -p --force --trust \
  -w my-feature \
  --worktree-base feat/my-branch \
  --output-format stream-json \
  "Read .cursor-task.md and implement everything described. \
   Run pnpm typecheck when done. \
   Commit with message 'feat: description of work'." \
  > /tmp/cursor-output.log 2>&1 &
```

Or from Claude Code, use the Bash tool with `run_in_background`:
```bash
agent -p --force --trust -w my-feature --worktree-base main "your prompt"
```

### 3. Check results

```bash
# Check the worktree for changes
cd ~/.cursor/worktrees/<repo>/<worktree-name>
git log --oneline -5
git diff --stat HEAD~1

# If satisfied, create a PR or cherry-pick into your branch
git push -u origin <worktree-branch>
gh pr create --base your-branch --title "feat: ..." --body "..."
```

### 4. Clean up worktree

```bash
git worktree remove ~/.cursor/worktrees/<repo>/<worktree-name>
git branch -D <worktree-branch>
```

## Output formats

### text (default)
Clean final-answer output. Best for simple tasks.

### json
Structured output with `.result` field. Parse with `jq -r '.result'`.

### stream-json
Real-time progress tracking. Each line is a JSON object with `type` field:
- `system` — init info
- `user` — echoed prompt
- `thinking` — model reasoning
- `text` — generated text (`.content` field)
- `tool_call` — tool invocations
- `result` — final result

## Tips

- **Always use `--force`** for tasks that need to write code. Without it, Cursor only proposes changes.
- **Always use `--trust`** in headless mode to skip workspace trust prompts.
- **Worktrees are key** for parallel work — they give Cursor a full isolated copy of the repo.
- **Reference files in prompts** — Cursor auto-reads them via tool calls. Say "Read src/foo.ts for the pattern to follow."
- **Keep prompts self-contained** — Cursor has no context from your Claude session.
- **Spec files prevent drift** — write `.cursor-task.md` with exact deliverables rather than relying on a long prompt string.
- **Clean up task files** — delete `.cursor-task.md` after the work is done so it doesn't get committed.

## Troubleshooting

- **Silent exit / no output**: Check `agent --version` works. Make sure you're calling `agent`, not `cursor agent`.
- **Auth errors**: Run `agent login` or set `CURSOR_API_KEY` env var.
- **Worktree conflicts**: Clean up with `git worktree list` and `git worktree remove <path>`.

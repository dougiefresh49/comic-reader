---
name: gemini-cli
description: Delegate coding tasks to Gemini CLI running in headless mode. Use when parallelizing work or getting a second opinion on code — Gemini works in an isolated git worktree while Claude continues on the main branch. Good for code review, well-specced implementation tasks, or analysis.
---

## When to use

- Parallelizing independent coding tasks (Gemini works in a worktree, you keep working)
- Getting a second opinion / code review on changes
- Delegating well-specced tasks with clear inputs/outputs
- Batch code generation, refactoring, or analysis

## Prerequisites

- Gemini CLI installed (`npm install -g @anthropic-ai/gemini-cli` or see official install docs)
- Authenticated (`gemini` interactive first run, or `GEMINI_API_KEY` env var)
- Current directory is a git repo (worktrees require git)
- For worktrees: `experimental.worktrees: true` must be set in Gemini settings

## Command syntax

```bash
# Basic headless query (read-only analysis)
gemini -p "your prompt here"

# With auto-approve for file modifications
gemini -p --approval-mode=yolo "your prompt here"

# Full headless with trust (no confirmation prompts)
gemini -p --approval-mode=yolo --skip-trust "your prompt here"

# In an isolated git worktree (recommended for parallel work)
gemini -p --approval-mode=yolo --skip-trust -w my-feature "your prompt"

# With specific model
gemini -p -m flash "your prompt here"

# Pipe content in
cat src/foo.ts | gemini -p "review this file for bugs"

# JSON output (structured)
gemini -p --output-format json "your prompt here"

# Streaming JSON output (real-time progress)
gemini -p --output-format stream-json "your prompt here"
```

## Key flags

| Flag | Alias | Purpose |
|------|-------|---------|
| `--prompt` | `-p` | Non-interactive mode (required for headless) |
| `--approval-mode=yolo` | — | Auto-approve all tool actions (file edits, shell commands) |
| `--yolo` | `-y` | **Deprecated.** Use `--approval-mode=yolo` instead |
| `--skip-trust` | — | Trust workspace without prompting (headless only) |
| `--worktree [name]` | `-w` | Run in isolated git worktree (experimental) |
| `--model <model>` | `-m` | Model override: `auto`, `pro`, `flash`, `flash-lite`, or full model ID |
| `--output-format <fmt>` | `-o` | `text` (default), `json` (structured), `stream-json` (progress) |
| `--sandbox` | `-s` | Run in sandboxed environment for safer execution |
| `--debug` | `-d` | Verbose logging |
| `--resume <id>` | `-r` | Resume a previous session (`"latest"` or session ID) |
| `--include-directories` | — | Additional directories to include in workspace |

## Model aliases

| Alias | Resolves To | Use when |
|-------|-------------|----------|
| `auto` | `gemini-2.5-pro` / `gemini-3-pro-preview` | Default — complex reasoning |
| `pro` | `gemini-2.5-pro` / `gemini-3-pro-preview` | Complex reasoning tasks |
| `flash` | `gemini-2.5-flash` | Fast, balanced — most tasks |
| `flash-lite` | `gemini-2.5-flash-lite` | Fastest — simple/rule-based tasks |

## Workflow: delegate task to Gemini in a worktree

### 1. Write a task spec

Write a clear, self-contained spec file (e.g., `.gemini-task.md`) that includes:
- What to build (concrete deliverables)
- Files to create and modify
- Files NOT to modify (avoid merge conflicts with your parallel work)
- Existing patterns to follow (reference specific files)
- How to verify (e.g., `pnpm typecheck`)

### 2. Launch Gemini in background

```bash
gemini -p --approval-mode=yolo --skip-trust \
  -w my-feature \
  --output-format stream-json \
  "Read .gemini-task.md and implement everything described. \
   Run pnpm typecheck when done. \
   Commit with message 'feat: description of work'." \
  > /tmp/gemini-output.log 2>&1 &
```

Or from Claude Code, use the Bash tool with `run_in_background`:
```bash
gemini -p --approval-mode=yolo --skip-trust -w my-feature "your prompt"
```

### 3. Check results

```bash
# Check the worktree for changes
cd ~/.gemini/worktrees/<repo>/<worktree-name>
git log --oneline -5
git diff --stat HEAD~1

# If satisfied, create a PR or cherry-pick into your branch
git push -u origin <worktree-branch>
gh pr create --base your-branch --title "feat: ..." --body "..."
```

### 4. Clean up worktree

```bash
git worktree remove ~/.gemini/worktrees/<repo>/<worktree-name>
git branch -D <worktree-branch>
```

## Output formats

### text (default)
Clean final-answer output. Best for simple tasks.

### json
Single JSON object with fields:
- `response`: (string) The model's final answer
- `stats`: (object) Token usage and API latency metrics
- `error`: (object, optional) Error details if request failed

Parse with `jq -r '.response'`.

### stream-json
Real-time JSONL progress tracking. Each line is a JSON object with `type` field:
- `init` — session metadata (session ID, model)
- `message` — user and assistant message chunks
- `tool_use` — tool call requests with arguments
- `tool_result` — output from executed tools
- `error` — non-fatal warnings and system errors
- `result` — final outcome with aggregated statistics

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error or API failure |
| `42` | Input error (invalid prompt or arguments) |
| `53` | Turn limit exceeded |

## Tips

- **Always use `--approval-mode=yolo`** for tasks that need to write code. Without it, Gemini only proposes changes.
- **Always use `--skip-trust`** in headless mode to skip workspace trust prompts.
- **Worktrees are experimental** — requires `experimental.worktrees: true` in settings.
- **Reference files in prompts** — Gemini auto-reads them via tool calls. Say "Read src/foo.ts for the pattern to follow."
- **Keep prompts self-contained** — Gemini has no context from your Claude session.
- **Spec files prevent drift** — write `.gemini-task.md` with exact deliverables rather than relying on a long prompt string.
- **Clean up task files** — delete `.gemini-task.md` after the work is done so it doesn't get committed.
- **Pipe for review** — `cat src/file.ts | gemini -p "review this for bugs"` is great for quick second opinions.

## Troubleshooting

- **Silent exit / no output**: Check `gemini --version` works. Ensure `-p` flag is present for headless mode.
- **Auth errors**: Run `gemini` interactively first to authenticate, or set `GEMINI_API_KEY` env var.
- **Worktree not working**: Ensure `experimental.worktrees: true` is set in Gemini settings.
- **Approval prompts blocking**: Use `--approval-mode=yolo` (not the deprecated `--yolo`/`-y`).

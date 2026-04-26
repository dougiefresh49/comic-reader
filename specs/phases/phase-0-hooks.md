# Phase 0 — Foundation: Claude Code Hooks + CLAUDE.md

## Goal
Set up a safe, self-documenting development environment so every future Claude session starts with full project context and automatic safeguards.

## Why First
Hooks auto-format code, auto-type-check after script edits, guard irreplaceable source assets, and inject pipeline status on every session start. CLAUDE.md means you never re-explain the project to a new Claude session.

---

## Deliverables

### 1. `.claude/settings.json`
Project-scoped hook configuration (committable to git).

**Hooks:**
| Event | Matcher | Script | Purpose |
|-------|---------|--------|---------|
| `SessionStart` | `startup\|resume` | `session-init.sh` | Print pipeline checkpoint status on session open |
| `PostToolUse` | `Write\|Edit` | `format-on-save.sh` | Auto-prettier + async tsc on `.ts`/`.tsx` files |
| `PreToolUse` | `Bash` | `guard-assets.sh` | Block `rm -rf` or destructive ops on `assets/` and `public/comics/` |
| `Stop` | — | `stop-reminder.sh` | After each turn, nudge if scripts were modified |

### 2. `.claude/hooks/session-init.sh`
On startup, scans `assets/comics/` for `checkpoint.json` files and prints a status table:
```
📚 Comic Reader — Pipeline Status
──────────────────────────────────
tmnt-mmpr / issue-3   ✓ complete (12 steps)
tmnt-mmpr / issue-4   ⏸ paused at: generate-audio (step 10/12)
batman / issue-1      🆕 not started
```

### 3. `.claude/hooks/format-on-save.sh`
- Receives `tool_name` and `tool_input.file_path` from stdin (JSON)
- If file ends in `.ts` or `.tsx`: runs `pnpm prettier --write <path>`
- Runs async (non-blocking) so it doesn't slow down Claude's response

### 4. `.claude/hooks/guard-assets.sh`
- Reads `tool_input.command` from stdin
- Blocks if command matches: `rm -rf.*assets/` or `rm -rf.*public/comics/`
- Returns exit 2 with a message explaining why

### 5. `.claude/hooks/stop-reminder.sh`
- Checks if any `scripts/*.ts` files were modified this session (via transcript)
- If yes, outputs: `"Scripts were edited — run pnpm typecheck to verify before moving on."`

### 6. `.claude/settings.local.json.example`
Template for personal env vars that don't get committed:
```json
{
  "env": {
    "GEMINI_API_KEY": "your-key-here",
    "ELEVENLABS_API_KEY": "your-key-here",
    "ROBOFLOW_API_KEY": "your-key-here"
  }
}
```

### 7. `CLAUDE.md`
Project documentation for Claude sessions. Covers:
- What this project is (one paragraph)
- Pipeline step order with script names
- Data directory layout
- Gemini model tier guide (HIGH/MEDIUM/FAST and when to use each)
- Key env vars
- Common commands
- Phase plan index with links to `specs/phases/`

---

## Implementation Steps

1. Create `.claude/hooks/` directory
2. Write all 4 bash hook scripts (ensure `chmod +x`)
3. Write `.claude/settings.json` wiring hooks to events
4. Write `.claude/settings.local.json.example`
5. Write `CLAUDE.md` at project root

## Verification
- Open a new Claude Code session in this project
- Confirm session-init hook prints pipeline status
- Edit a `.ts` file — confirm prettier runs automatically
- Try running `rm -rf assets/` in a Bash tool call — confirm it's blocked
- Run `/hooks` in Claude Code to view configured hooks

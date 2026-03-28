# tom

Multi-agent coding harness for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Discovery → Plan → Build → Evaluate → Review.

Inspired by Anthropic's [long-running agent harnesses](https://www.anthropic.com/engineering/harness-design-long-running-apps) and their [autonomous-coding quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding).

## Quick Start

```bash
git clone https://github.com/kunalvarkekar/tom.git
cd tom && npm install && npm link
tom "add webhook retry logic with exponential backoff"
```

That's it. Tom opens a discovery chat, plans the work, builds it, evaluates it, reviews it, and drops you into an interactive Claude session.

## Table of Contents

- [Install](#install)
- [Commands](#commands)
- [Pipeline](#pipeline)
- [Configuration](#configuration)
- [Options](#options)
- [Multi-repo Support](#multi-repo-support)
- [Architecture](#architecture)

## Install

Requires [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) and Node.js 20+.

```bash
git clone https://github.com/kunalvarkekar/tom.git
cd tom && npm install && npm link
```

## Commands

```bash
tom "your task"         # full pipeline (discovery → plan → build → eval → review)
tom -s "clear task"     # skip discovery, go straight to planning
tom --plan-only "task"  # just plan, don't build
tom --continue          # resume from where you left off
tom status              # show current .tom/ state
tom pr                  # organize commits + create PR
```

## Pipeline

```
tom "add retry logic"
 │
 ├─ DISCOVERY ·········· Chat with a senior architect. Explore the codebase,
 │                       refine the task. /exit when ready.
 │
 ├─ PLANNER ············ Reads codebase, writes plan + testable contract.
 │                       You approve, tweak (unlimited), or abort.
 │
 ├─ GENERATOR ·········· Implements in sprints. Commits after each.
 │                       Creates branch from latest main.
 │
 ├─ EVALUATOR ·········· Tests every criterion. Real endpoints, real DB,
 │  │                    real browsers. No mocks. Writes critique.
 │  └─ loops ··········· If criteria fail → generator fixes → evaluator
 │                       re-grades. Up to 4 iterations.
 │
 ├─ REVIEWER ··········· Senior-dev code review. Challenges decisions,
 │                       pushes for simpler code.
 │
 ├─ NOTIFICATION ······· macOS desktop notification when done.
 │
 └─ INTERACTIVE ········ Opens Claude CLI with full context loaded.
                         Ask questions, tweak code, review screenshots.
```

## Configuration

Create `.tom/config.json` in your project root:

```json
{
  "branchPrefix": "yourname/feat-",
  "model": "opus",
  "maxIterations": 4,
  "skipChat": false,
  "customPrompt": "Project-specific instructions for all agents."
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `branchPrefix` | Git branch prefix | `<git-username>/feat-` |
| `model` | Claude model for all agents | `opus` |
| `maxIterations` | Max generate-evaluate loops | `4` |
| `skipChat` | Skip discovery chat by default | `false` |
| `customPrompt` | Appended to all agent prompts | - |

### Custom Prompt

Use `customPrompt` for project-specific instructions that all agents should follow:

```json
{
  "customPrompt": "Use MongoDB MCP to verify DB state. For auth testing, use getDemoToken() from src/helpers/auth.ts. DO NOT use Playwright for full-page navigation — use Component Testing instead."
}
```

CLI flags override config values.

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--model <model>` | | Model for all agents |
| `--max-iterations <n>` | | Max eval loops |
| `--skip-chat` | `-s` | Skip discovery, go straight to planning |
| `--skip-plan` | | Auto-approve the plan |
| `--plan-only` | | Stop after planning |
| `--no-interactive` | | Skip interactive session at end |
| `--no-branch` | | Don't create git branches |
| `--no-review` | | Skip code review phase |
| `--quiet` | `-q` | Suppress agent output |
| `--continue` | | Resume previous run |
| `--mcp-config <path>` | | MCP config for evaluator |
| `--max-budget-usd <n>` | | Total budget cap |

## Multi-repo Support

When tom detects multiple git repos in the working directory (e.g., `frontend/`, `backend/`), it automatically:

- Tells the planner about all repos
- Creates branches in each repo
- Runs pre-flight type checks per repo
- `tom pr` creates PRs in each repo with changes

## Architecture

```
tom/src/
  index.ts              CLI + orchestrator
  spawn.ts              Spawns claude -p with stream-json
  types.ts              TypeScript types
  contract.ts           Parses contract.json + critique.md
  display.ts            Terminal formatting
  prompts/
    planner.md          "Read codebase, write plan + contract"
    generator.md        "Implement the plan in sprints"
    evaluator.md        "Test everything, no mocks"
    reviewer.md         "Senior-dev code review"
    pr.md               "Organize commits, create PR"
```

Each agent is a `claude -p` subprocess with `--append-system-prompt`. No SDK, no framework — just the CLI with role-specific prompts.

### File Communication

Agents communicate via `.tom/` in your project root:

| File | Writer | Reader |
|------|--------|--------|
| `plan.md` | Planner | Generator, Reviewer |
| `contract.json` | Planner | Generator, Evaluator |
| `discovery.md` | Discovery chat | Planner |
| `handoff.md` | Generator | Evaluator |
| `critique.md` | Evaluator | Generator (retry) |
| `review.md` | Reviewer | You |
| `test-scripts/` | Evaluator | You |
| `screenshots/` | Evaluator | You |

### Key Design Decisions

- **No mocks** — evaluator tests against real systems
- **Contract-driven** — binary pass/fail criteria, not vibes
- **Fresh context per agent** — state passes through files
- **Persistent planner** — tweaks resume the same session via `--resume`
- **Pre-flight checks** — TSC before generator starts
- **Desktop notifications** — walk away, come back when done

## License

MIT — Kunal Varkekar

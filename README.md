# tom

Multi-agent coding harness for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Discovery → Plan → Build → Evaluate → Review.

Inspired by Anthropic's [long-running agent harnesses](https://www.anthropic.com/engineering/harness-design-long-running-apps) and their [autonomous-coding quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding).

## Human Text

Hey! Although this entire thing is Claude generated. This bit is written by me. This is a little tool I made to make my workflow easier. It follows Anthropics article on the agent harness and makes use of Claude Code and some pre built prompts to just quick start everything needed for a new feature. It has some configs to make it customizable as needed. Feel free to open issues or PR's if you want a new feature. Anything that can help make our lives easier to code faster and better is appreciated. Thank you!

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
tom -i 1234             # fetch Linear issue and use as task
tom --plan-only "task"  # just plan, don't build
tom --continue          # resume from where you left off
tom status              # show current .tom/ state
tom watch               # monitor all sessions across worktrees
tom pr                  # organize commits + create PR
tom sync                # merge latest main into current branch
tom sync branch-name    # switch to branch (create if needed) + merge main
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

Tom uses two config files. Global loads first, project overrides.

### Global Config (`~/.tom/config.json`)

Settings that apply everywhere — your identity, model, integrations:

```json
{
  "branchPrefix": "yourname/feat-",
  "model": "opus",
  "linearTeam": "ENG",
  "reviewCommand": "/tira-review"
}
```

### Project Config (`.tom/config.json`)

Project-specific settings — custom prompts, repo branches:

```json
{
  "customPrompt": "Use MongoDB MCP to verify DB state.",
  "repoBranches": { "automations": "staging" },
  "baseBranch": "main"
}
```

See [`config.example.json`](config.example.json) for a full example.

### All Config Options

| Key | Description | Default |
|-----|-------------|---------|
| `branchPrefix` | Git branch prefix | `<git-username>/feat-` |
| `model` | Claude model for all agents | `opus` |
| `maxIterations` | Max generate-evaluate loops | `4` |
| `skipChat` | Skip discovery chat by default | `false` |
| `linearTeam` | Linear team prefix (e.g. `ENG`) | - |
| `reviewCommand` | Custom review command (e.g. `/tira-review`) | built-in reviewer |
| `baseBranch` | Default base branch | `main` |
| `repoBranches` | Per-repo base branch overrides | `{}` |
| `customPrompt` | Appended to all agent prompts | - |

### Linear Integration

Fetch issues directly as tasks:

```bash
tom -i 1234           # fetches ENG-1234 (uses linearTeam from config)
tom -i ENG-1234       # explicit team prefix
```

Requires `LINEAR_API_KEY` env var. Get your key from Linear → Settings → API → Personal API Keys.

```bash
echo 'export LINEAR_API_KEY="lin_api_..."' >> ~/.zshrc && source ~/.zshrc
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
| `--issue <id>` | `-i` | Fetch Linear issue as task |
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

## Contributing

[Open an issue](https://github.com/kuki1029/tom/issues) for bugs or feature requests. PRs welcome.

## License

MIT — Kunal Varkekar

#!/usr/bin/env npx tsx

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { execSync, spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import type { AgentResult, Config } from "./types.js"
import { spawnAgent } from "./spawn.js"
import { parseContract, parseCritique, allPassed } from "./contract.js"
import {
  printPhaseBanner,
  printPlanSummary,
  printCritiqueSummary,
  printCostSummary,
  printStatus,
} from "./display.js"

// ========= Config =========

const DEFAULT_CONFIG: Config = {
  model: "opus",
  maxIterations: 4,
  skipPlan: false,
  planOnly: false,
  noInteractive: false,
  noBranch: false,
  quiet: false,
  continueRun: false,
  noReview: false,
  branchPrefix: getDefaultBranchPrefix(),
  baseBranch: "main",
  repoBranches: {},
  skipChat: false,
}

function getDefaultBranchPrefix(): string {
  try {
    const name = execSync("git config user.name", { stdio: "pipe" })
      .toString().trim().toLowerCase().replace(/\s+/g, "-")
    return `${name}/feat-`
  } catch {
    return "feat-"
  }
}

// Load .tom/config.json if it exists, merge with defaults
const loadProjectConfig = (cwd: string): Partial<Config> => {
  const configPath = path.join(cwd, ".tom", "config.json")
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch {
    return {}
  }
}

// ========= CLI Parsing =========

const SUBCOMMANDS = ["status", "pr", "sync"] as const
type Subcommand = typeof SUBCOMMANDS[number]

const parseCliArgs = (): { task: string; config: Config; subcommand?: Subcommand } => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      "max-iterations": { type: "string" },
      "skip-plan": { type: "boolean", default: false },
      "plan-only": { type: "boolean", default: false },
      "no-interactive": { type: "boolean", default: false },
      "no-branch": { type: "boolean", default: false },
      "no-review": { type: "boolean", default: false },
      "skip-chat": { type: "boolean", short: "s", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      continue: { type: "boolean", default: false },
      "mcp-config": { type: "string" },
      "max-budget-usd": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  })

  // Check for subcommand
  const firstArg = positionals[0]
  if (firstArg && SUBCOMMANDS.includes(firstArg as Subcommand)) {
    return { task: "", config: DEFAULT_CONFIG, subcommand: firstArg as Subcommand }
  }

  if (values.help || (positionals.length === 0 && !values.continue)) {
    console.log(`
  tom <task> [options]
  tom status                    Show current .tom/ state
  tom pr                        Create PR from .tom/ artifacts
  tom sync [branch]             Fetch main + merge into current (or given) branch

  Arguments:
    task                    What to build (quoted string)

  Options:
    --model <model>         Model for all agents (default: "opus")
    --max-iterations <n>    Max generate-evaluate loops (default: 4)
    --skip-plan             Skip plan approval checkpoint
    --plan-only             Run planner and stop
    --no-interactive        Skip the final interactive session
    --no-branch             Don't create a new git branch
    --no-review             Skip the code review phase
    -s, --skip-chat         Skip discovery chat, go straight to planning
    --quiet, -q             Suppress agent output (default: show everything)
    --continue              Resume from last run's .tom/ state
    --mcp-config <path>     MCP config for evaluator (Playwright, etc.)
    --max-budget-usd <n>    Total budget cap across all agents
    -h, --help              Show this help
`)
    process.exit(0)
  }

  // Merge: defaults ← project config ← CLI flags
  const projectConfig = loadProjectConfig(process.cwd())
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...projectConfig,
    ...(values.model && { model: values.model }),
    ...(values["max-iterations"] && { maxIterations: parseInt(values["max-iterations"], 10) }),
    skipPlan: values["skip-plan"] as boolean,
    planOnly: values["plan-only"] as boolean,
    noInteractive: values["no-interactive"] as boolean,
    noBranch: values["no-branch"] as boolean,
    noReview: values["no-review"] as boolean,
    skipChat: values["skip-chat"] as boolean,
    quiet: values.quiet as boolean,
    continueRun: values.continue as boolean,
    mcpConfig: values["mcp-config"] as string | undefined,
    maxBudgetUsd: values["max-budget-usd"]
      ? parseFloat(values["max-budget-usd"] as string)
      : undefined,
  }

  return { task: positionals.join(" "), config }
}

// ========= Utilities =========

/** Extract a human-readable message from execSync errors (which carry stderr as a Buffer). */
const getExecError = (err: unknown): string => {
  if (err instanceof Error && "stderr" in err) {
    const stderr = (err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr
    if (stderr) return stderr.toString()
  }
  return err instanceof Error ? err.message : String(err)
}

const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

const readMultilineInput = (): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const lines: string[] = []
  console.log("  Enter feedback (empty line to finish):")
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line === "") {
        rl.close()
        resolve(lines.join("\n"))
      } else {
        lines.push(line)
      }
    })
  })
}

const notify = (title: string, message: string): void => {
  try {
    execSync(
      `osascript -e 'display notification "${message}" with title "${title}"'`,
      { stdio: "pipe" }
    )
  } catch {
    // not on macOS or notification failed
  }
}

// ========= Multi-repo Detection =========

const detectRepos = (cwd: string): string[] => {
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && fs.existsSync(path.join(cwd, e.name, ".git")))
      .map(e => e.name)
  } catch {
    return []
  }
}

// ========= .tom/ Directory =========

const cleanTomDir = (tomDir: string): void => {
  const artifacts = ["plan.md", "contract.json", "handoff.md", "critique.md", "review.md"]
  for (const file of artifacts) {
    const filePath = path.join(tomDir, file)
    if (fs.existsSync(filePath)) fs.rmSync(filePath)
  }
  const testScriptsDir = path.join(tomDir, "test-scripts")
  if (fs.existsSync(testScriptsDir)) fs.rmSync(testScriptsDir, { recursive: true })
  const screenshotsDir = path.join(tomDir, "screenshots")
  if (fs.existsSync(screenshotsDir)) fs.rmSync(screenshotsDir, { recursive: true })
}

const ensureTomDir = (cwd: string, clean: boolean): string => {
  const tomDir = path.join(cwd, ".tom")
  fs.mkdirSync(tomDir, { recursive: true })
  if (clean) cleanTomDir(tomDir)
  fs.mkdirSync(path.join(tomDir, "test-scripts"), { recursive: true })
  return tomDir
}

// ========= Git =========

const getBaseBranch = (dir: string, config: Config): string => {
  const repoName = path.basename(dir)
  // Per-repo override first
  if (config.repoBranches[repoName]) return config.repoBranches[repoName]
  // Then global config
  if (config.baseBranch !== "main") return config.baseBranch
  // Then detect from git
  try {
    return execSync("git symbolic-ref refs/remotes/origin/HEAD", { cwd: dir, stdio: "pipe" })
      .toString().trim().replace("refs/remotes/origin/", "")
  } catch {
    return config.baseBranch
  }
}

const toBranchName = (task: string, prefix: string): string => {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "")
  return `${prefix}${slug}`
}

const createBranch = (cwd: string, task: string, prefix: string, repos: string[], config: Config): void => {
  const branch = toBranchName(task, prefix)
  const targets = repos.length ? repos.map(r => path.join(cwd, r)) : [cwd]

  for (const dir of targets) {
    const mainBranch = getBaseBranch(dir, config)
    const repoName = path.basename(dir)

    try {
      execSync(`git fetch origin ${mainBranch}`, { cwd: dir, stdio: "pipe" })
      execSync(`git checkout -b ${branch} origin/${mainBranch}`, { cwd: dir, stdio: "pipe" })
      console.log(`  ${repoName}: branch created ${branch} (from origin/${mainBranch})`)
    } catch (err) {
      const msg = getExecError(err)
      try {
        execSync(`git checkout ${branch}`, { cwd: dir, stdio: "pipe" })
        console.log(`  ${repoName}: switched to existing branch ${branch}`)
      } catch {
        console.log(`  ${repoName}: staying on current branch (${msg.trim()})`)
      }
    }
  }
  console.log()
}

// ========= Pre-flight =========

const preflight = (cwd: string, repos: string[]): void => {
  console.log(`  Pre-flight checks:`)
  const targets = repos.length ? repos : ["."]
  for (const repo of targets) {
    const dir = path.join(cwd, repo)
    if (!fs.existsSync(path.join(dir, "tsconfig.json"))) continue

    try {
      execSync("npx tsc --noEmit", { cwd: dir, stdio: "pipe", timeout: 60000 })
      console.log(`    ✓ ${repo === "." ? "project" : repo} compiles`)
    } catch (err) {
      const firstErrors = getExecError(err).split("\n").slice(0, 5).join("\n")
      console.error(`    ✗ ${repo === "." ? "project" : repo} has type errors:`)
      console.error(`      ${firstErrors}`)
    }
  }
  console.log()
}

// ========= PR Creation =========

const createPR = async (cwd: string, config: Config): Promise<void> => {
  const tomDir = path.join(cwd, ".tom")

  if (!fs.existsSync(path.join(tomDir, "contract.json"))) {
    console.error("No .tom/contract.json found. Run tom first.")
    process.exit(1)
  }

  printPhaseBanner("PR")
  const result = await spawnAgent({ role: "pr", task: "", cwd, config })

  if (result.isError) {
    console.error("PR agent failed. Check output above for details.")
    process.exit(1)
  }

  printCostSummary([result])
}

// ========= Sync =========

const syncWithMain = (cwd: string, config: Config, targetBranch?: string): void => {
  const repos = detectRepos(cwd)
  const targets = repos.length ? repos.map(r => path.join(cwd, r)) : [cwd]

  for (const dir of targets) {
    const repoName = repos.length ? path.basename(dir) : "project"
    const mainBranch = getBaseBranch(dir, config)

    try {
      // Always fetch first
      execSync(`git fetch origin ${mainBranch}`, { cwd: dir, stdio: "pipe" })

      // Switch to target branch if specified — create from main if it doesn't exist
      if (targetBranch) {
        try {
          execSync(`git checkout ${targetBranch}`, { cwd: dir, stdio: "pipe" })
        } catch {
          execSync(`git checkout -b ${targetBranch} origin/${mainBranch}`, { cwd: dir, stdio: "pipe" })
          console.log(`  ${repoName}: created ${targetBranch} from origin/${mainBranch}`)
        }
      }

      const currentBranch = execSync("git branch --show-current", { cwd: dir, stdio: "pipe" })
        .toString().trim()

      if (currentBranch === mainBranch) {
        execSync(`git pull origin ${mainBranch}`, { cwd: dir, stdio: "pipe" })
        console.log(`  ${repoName}: pulled latest ${mainBranch}`)
      } else {
        execSync(`git merge origin/${mainBranch}`, { cwd: dir, stdio: "pipe" })
        console.log(`  ${repoName}: merged origin/${mainBranch} into ${currentBranch}`)
      }
    } catch (err) {
      const msg = getExecError(err)
      console.error(`  ${repoName}: sync failed — ${msg.trim()}`)
    }
  }
}

// ========= Discovery Chat =========

const runDiscovery = (cwd: string, task: string, repos: string[]): void => {
  const repoContext = repos.length > 1 ? `\nRepos: ${repos.join(", ")}` : ""

  const systemPrompt = [
    "You are a senior software architect helping design a feature for an enterprise-grade product.",
    "No shortcuts, no workarounds, no time pressure. Build it right, build it to last.",
    "",
    "## Your job in this session",
    "",
    "- Explore the codebase with the user. Read the relevant code, understand existing patterns.",
    "- Ask clarifying questions — don't assume you know the requirements.",
    "- Challenge vague ideas. Push for specifics: what exactly should happen? What are the edge cases?",
    "- Identify existing patterns, utilities, and infrastructure that should be reused.",
    "- Flag potential concerns: backwards compatibility, data migrations, performance implications, security.",
    "- Discuss trade-offs between approaches. Present options with pros/cons, let the user decide.",
    "- Think about what could break. What existing features depend on the code we'd change?",
    "",
    "## When the user is ready to proceed",
    "",
    "Before they /exit, write .tom/discovery.md containing:",
    "- **Refined task**: what exactly we're building (specific, not vague)",
    "- **Key findings**: what we learned about the codebase that matters for this task",
    "- **Agreed approach**: the architecture/design decision made during discussion",
    "- **Files involved**: specific files that will need changes and why",
    "- **Risks & edge cases**: anything that could go wrong or needs special handling",
    "- **Out of scope**: what we explicitly decided NOT to do",
    "",
    "This document feeds directly into the planner. Be precise.",
  ].join("\n")

  // Put the task in the system prompt so Claude has it as context
  // and immediately starts exploring when the user sends any message
  const fullPrompt = [
    systemPrompt,
    "",
    `## Task to explore`,
    "",
    `${task}${repoContext}`,
    "",
    "Start by reading the relevant code for this task. Share your initial findings and ask clarifying questions.",
    "The user's first message will kick things off — dive straight into exploring.",
  ].join("\n")

  printPhaseBanner("DISCOVERY")
  console.log("  Chat with the architect. Explore the codebase, refine the task.")
  console.log("  Type /exit when ready to proceed to planning.\n")

  spawnSync("claude", ["--append-system-prompt", fullPrompt], {
    cwd,
    stdio: "inherit",
  })
}

// ========= Interactive Session =========

const openInteractiveSession = (cwd: string): void => {
  const contextPrompt = [
    "You are continuing a coding session managed by Tom.",
    "Read these files for full context:",
    "- .tom/plan.md — the implementation plan",
    "- .tom/contract.json — the testable criteria",
    "- .tom/handoff.md — what was built",
    "- .tom/critique.md — the evaluator's verdict",
    "- .tom/test-scripts/ — test scripts the evaluator wrote and ran",
    "- .tom/review.md — code review findings",
    "- .tom/screenshots/ — visual test screenshots (if any)",
    "- .tom/screenshots/report.html — visual report with embedded screenshots (if exists)",
    "",
    "The user is here to review. Answer their questions about the implementation.",
    "If .tom/screenshots/report.html exists, tell the user to open it: open .tom/screenshots/report.html",
  ].join("\n")

  spawnSync("claude", ["--append-system-prompt", contextPrompt], {
    cwd,
    stdio: "inherit",
  })
}

// ========= Continue State Detection =========

const detectContinueState = (tomDir: string): "plan" | "generate" | "evaluate" | "done" => {
  const hasCritique = fs.existsSync(path.join(tomDir, "critique.md"))
  const hasHandoff = fs.existsSync(path.join(tomDir, "handoff.md"))
  const hasContract = fs.existsSync(path.join(tomDir, "contract.json"))

  if (hasCritique) {
    const critique = parseCritique(tomDir)
    return allPassed(critique) ? "done" : "generate"
  }
  if (hasHandoff) return "evaluate"
  if (hasContract) return "generate"
  return "plan"
}

// ========= Main Pipeline =========

const run = async (task: string, config: Config): Promise<void> => {
  const cwd = process.cwd()
  const repos = detectRepos(cwd)
  const results: AgentResult[] = []

  if (repos.length > 1) {
    console.log(`  Multi-repo detected: ${repos.join(", ")}\n`)
  }

  // Handle --continue
  if (config.continueRun) {
    const tomDir = path.join(cwd, ".tom")
    if (!fs.existsSync(path.join(tomDir, "contract.json"))) {
      console.error("No .tom/ state found. Run tom with a task first.")
      process.exit(1)
    }

    const state = detectContinueState(tomDir)

    if (state === "done") {
      console.log("Previous run passed all criteria. Opening interactive session.\n")
      if (!config.noInteractive) openInteractiveSession(cwd)
      return
    }

    const contract = parseContract(tomDir)
    const resumeTask = task || contract.task

    if (state === "evaluate") {
      printPhaseBanner("EVALUATOR (resumed)")
      const evalResult = await spawnAgent({ role: "evaluator", task: resumeTask, cwd, config })
      results.push(evalResult)
      const critique = parseCritique(tomDir)
      printCritiqueSummary(critique)
      if (allPassed(critique)) {
        printCostSummary(results)
        if (!config.noInteractive) openInteractiveSession(cwd)
        return
      }
    }

    const startIteration = state === "generate" ? 0 : 1
    for (let iteration = startIteration; iteration < config.maxIterations; iteration++) {
      printPhaseBanner(`GENERATOR (iteration ${iteration + 1})`)
      const genResult = await spawnAgent({ role: "generator", task: resumeTask, cwd, config, iteration })
      results.push(genResult)
      if (genResult.isError) { console.error("Generator failed."); break }

      printPhaseBanner(`EVALUATOR (iteration ${iteration + 1})`)
      const evalResult = await spawnAgent({ role: "evaluator", task: resumeTask, cwd, config })
      results.push(evalResult)
      const critique = parseCritique(tomDir)
      printCritiqueSummary(critique)
      if (allPassed(critique)) { console.log("  All criteria passed.\n"); break }
    }

    printCostSummary(results)
    notify("Tom", "Pipeline complete")
    if (!config.noInteractive) openInteractiveSession(cwd)
    return
  }

  // Fresh run
  const tomDir = ensureTomDir(cwd, true)

  // Phase 0: Discovery chat
  if (!config.skipChat) {
    runDiscovery(cwd, task, repos)
  }

  // Phase 1: Planner
  printPhaseBanner("PLANNER")
  const repoContext = repos.length > 1
    ? `\n\nThis project has multiple repos: ${repos.join(", ")}. Plan changes across repos as needed.`
    : ""
  const discoveryPath = path.join(tomDir, "discovery.md")
  const discoveryContext = fs.existsSync(discoveryPath)
    ? `\n\nDiscovery notes:\n${fs.readFileSync(discoveryPath, "utf-8")}`
    : ""
  const plannerResult = await spawnAgent({
    role: "planner",
    task: task + repoContext + discoveryContext,
    cwd,
    config,
  })
  results.push(plannerResult)
  let plannerSessionId = plannerResult.sessionId

  if (plannerResult.isError) {
    console.error("Planner failed. Check output above for details.")
    process.exit(1)
  }

  let contract = parseContract(tomDir)
  printPlanSummary(contract)

  if (config.planOnly) {
    printCostSummary(results)
    return
  }

  // Checkpoint: tweak loop
  if (!config.skipPlan) {
    let tweakRound = 0
    while (true) {
      const answer = await ask("Proceed? [y]es / [t]weak / [a]bort: ")
      if (answer.startsWith("y")) break
      if (answer.startsWith("a")) { console.log("Aborted."); return }

      if (answer.startsWith("t")) {
        tweakRound++
        const feedback = await readMultilineInput()
        printPhaseBanner(`PLANNER (tweak ${tweakRound})`)
        const revisedResult = await spawnAgent({
          role: "planner",
          task: `User feedback:\n${feedback}\n\nRevise the plan and contract accordingly. Update .tom/plan.md and .tom/contract.json.`,
          cwd,
          config,
          resumeSessionId: plannerSessionId,
        })
        results.push(revisedResult)
        plannerSessionId = revisedResult.sessionId

        if (revisedResult.isError) { console.error("Revised planner failed."); process.exit(1) }
        contract = parseContract(tomDir)
        printPlanSummary(contract)
      }
    }
  }

  // Create branch only in repos the planner identified (or all if not specified)
  const targetRepos = contract.repos?.length ? contract.repos : repos
  if (!config.noBranch) {
    createBranch(cwd, contract.task, config.branchPrefix, targetRepos, config)
  }

  // Pre-flight TSC check
  preflight(cwd, repos)

  // Phase 2-3: Generate-Evaluate loop
  for (let iteration = 0; iteration < config.maxIterations; iteration++) {
    printPhaseBanner(`GENERATOR (iteration ${iteration + 1})`)
    const genResult = await spawnAgent({ role: "generator", task, cwd, config, iteration })
    results.push(genResult)

    if (genResult.isError) {
      console.error("Generator failed. Check output above for details.")
      break
    }

    printPhaseBanner(`EVALUATOR (iteration ${iteration + 1})`)
    const evalResult = await spawnAgent({ role: "evaluator", task, cwd, config })
    results.push(evalResult)

    const critique = parseCritique(tomDir)
    printCritiqueSummary(critique)

    if (allPassed(critique)) {
      console.log("  All criteria passed.\n")
      notify("Tom", "All criteria passed")
      break
    }

    if (iteration < config.maxIterations - 1) {
      console.log(`  Retrying... (${config.maxIterations - iteration - 1} iterations remaining)\n`)
    } else {
      console.log("  Max iterations reached. Some criteria may still be failing.\n")
      notify("Tom", `Max iterations reached — some criteria failing`)
    }
  }

  // Phase 4: Code review
  if (!config.noReview) {
    printPhaseBanner("CODE REVIEW")
    const reviewResult = await spawnAgent({ role: "reviewer", task, cwd, config })
    results.push(reviewResult)
  }

  // Summary
  printCostSummary(results)
  notify("Tom", "Pipeline complete")

  // Phase 5: Interactive session
  if (!config.noInteractive) {
    console.log("Opening interactive Claude session...\n")
    openInteractiveSession(cwd)
  }
}

// ========= Entry =========

const { task, config, subcommand } = parseCliArgs()

if (subcommand === "status") {
  printStatus(process.cwd())
} else if (subcommand === "sync") {
  // tom sync [branch] — merge main into current or given branch
  const branchArg = process.argv[process.argv.indexOf("sync") + 1]
  syncWithMain(process.cwd(), config, branchArg)
} else if (subcommand === "pr") {
  createPR(process.cwd(), config).catch((err) => {
    console.error(`\nFatal: ${err.message}`)
    process.exit(1)
  })
} else {
  run(task, config).catch((err) => {
    console.error(`\nFatal: ${err.message}`)
    process.exit(1)
  })
}

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { AgentRole, AgentResult, Config } from "./types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = path.join(__dirname, "prompts")

const buildPromptPath = (role: AgentRole): string =>
  path.join(PROMPTS_DIR, `${role}.md`)

// All roles get full tool access — prompts constrain behavior per role
const buildPermissions = (_role: AgentRole): string[] =>
  ["--dangerously-skip-permissions"]

const buildBasePrompt = (role: AgentRole, task: string, cwd: string, iteration: number, config: Config): string => {
  switch (role) {
    case "planner":
      return `Task: ${task}\n\nProject: ${cwd}\n\nRead the codebase and produce .tom/plan.md and .tom/contract.json following the instructions in your system prompt.`
    case "generator":
      return iteration === 0
        ? `Task: ${task}\n\nRead .tom/plan.md and .tom/contract.json, then implement following the sprint order.`
        : `Task: ${task}\n\nRead .tom/critique.md — the evaluator found issues. Fix them. Then read .tom/contract.json to verify you've addressed all failing criteria.`
    case "evaluator":
      return `Read .tom/contract.json and evaluate the implementation. Write test scripts to .tom/test-scripts/, run them, and write your verdict to .tom/critique.md.`
    case "reviewer":
      return config.reviewCommand
        ?? `Task: ${task}\n\nReview all changes made in this session. Read .tom/plan.md and .tom/contract.json for context. Write your review to .tom/review.md.`
    case "pr":
      return `Organize commits, push the branch, and create a pull request. Read .tom/ artifacts for context.`
  }
}

const buildUserPrompt = (role: AgentRole, task: string, cwd: string, iteration: number, config: Config): string => {
  const base = buildBasePrompt(role, task, cwd, iteration, config)
  return config.customPrompt ? `${base}\n\nProject-specific instructions:\n${config.customPrompt}` : base
}

interface SpawnOptions {
  role: AgentRole
  task: string
  cwd: string
  config: Config
  iteration?: number
  resumeSessionId?: string
}

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const GREEN = "\x1b[32m"
const WHITE = "\x1b[37m"

const startTimer = (): NodeJS.Timeout => {
  const start = Date.now()
  return setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000)
    process.stderr.write(`\r${DIM}  Working... ${elapsed}s${RESET}`)
  }, 1000)
}

const stopTimer = (timer: NodeJS.Timeout): void => {
  clearInterval(timer)
  process.stderr.write("\r\x1b[K")
}

interface AssistantEvent {
  type: "assistant"
  message?: {
    content?: Array<{
      type: string
      name?: string
      input?: Record<string, unknown>
      text?: string
    }>
  }
}

interface ResultEvent {
  type: "result"
  result?: string
  total_cost_usd?: number
  duration_ms?: number
  session_id?: string
  is_error?: boolean
}

type StreamEvent = AssistantEvent | ResultEvent | { type: string }

const shortPath = (p: string): string =>
  String(p).replace(/^.*?\/(frontend|backend|automations)\//, "$1/")

const formatToolCall = (name: string, input: Record<string, unknown>): string => {
  const path = input.file_path ? shortPath(input.file_path as string) : ""

  if (name === "Read") return `  ${DIM}${CYAN}→${RESET} ${CYAN}Read${RESET} ${DIM}${path}${RESET}`
  if (name === "Write") return `  ${DIM}${CYAN}→${RESET} ${GREEN}Write${RESET} ${DIM}${path}${RESET}`
  if (name === "Edit") return `  ${DIM}${CYAN}→${RESET} ${YELLOW}Edit${RESET} ${DIM}${path}${RESET}`
  if (name === "Glob") return `  ${DIM}${CYAN}→${RESET} ${CYAN}Glob${RESET} ${DIM}${input.pattern}${RESET}`
  if (name === "Grep") return `  ${DIM}${CYAN}→${RESET} ${CYAN}Grep${RESET} ${DIM}"${input.pattern}"${RESET}`
  if (name === "Bash") return `  ${DIM}${CYAN}→${RESET} ${WHITE}Bash${RESET} ${DIM}${String(input.command).slice(0, 70)}${RESET}`
  if (name === "Agent") return `  ${DIM}${CYAN}→${RESET} ${YELLOW}Agent${RESET} ${DIM}${input.description}${RESET}`
  if (name === "TodoWrite") return `  ${DIM}${CYAN}→${RESET} ${DIM}TodoWrite${RESET}`

  return `  ${DIM}${CYAN}→${RESET} ${DIM}${name}${RESET}`
}

const formatEvent = (event: StreamEvent): string[] => {
  if (event.type !== "assistant") return []

  const assistantEvent = event as AssistantEvent
  const content = assistantEvent.message?.content
  if (!content) return []

  const lines: string[] = []
  for (const block of content) {
    if (block.type === "tool_use" && block.name && block.input) {
      lines.push(formatToolCall(block.name, block.input))
    }
    if (block.type === "text" && block.text) {
      lines.push(`\n\x1b[1m${block.text}${RESET}\n`)
    }
  }

  return lines
}

export const spawnAgent = ({ role, task, cwd, config, iteration = 0, resumeSessionId }: SpawnOptions): Promise<AgentResult> => {
  return new Promise((resolve, reject) => {
    const isResume = !!resumeSessionId

    const args = [
      // Resume existing session or start fresh
      ...(isResume ? ["--resume", resumeSessionId, "-p", task] : ["-p", buildUserPrompt(role, task, cwd, iteration, config)]),
      "--output-format", "stream-json",
      "--verbose",
      "--model", config.model,
      "--effort", "high",
      // Don't persist sessions except for planner (needed for resume on tweaks)
      ...(role === "planner" ? [] : ["--no-session-persistence"]),
      // Only append system prompt on fresh sessions (resume already has it)
      ...(isResume ? [] : ["--append-system-prompt-file", buildPromptPath(role)]),
      ...buildPermissions(role),
    ]

    if (config.mcpConfig && role === "evaluator") {
      args.push("--mcp-config", config.mcpConfig)
    }

    if (config.maxBudgetUsd) {
      args.push("--max-budget-usd", String(config.maxBudgetUsd))
    }

    const child = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })

    let buffer = ""
    let lastResult: ResultEvent | null = null
    let hasOutput = false
    const timer = startTimer()

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString()

      // Parse newline-delimited JSON events
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const event: StreamEvent = JSON.parse(trimmed)

          // Show tool calls in real time
          if (!config.quiet) {
            const lines = formatEvent(event)
            for (const line of lines) {
              if (!hasOutput) {
                stopTimer(timer)
                hasOutput = true
              }
              console.error(line)
            }
          }

          // Capture the final result event
          if (event.type === "result") {
            lastResult = event as ResultEvent
          }
        } catch {
          // incomplete JSON, ignore
        }
      }
    })

    child.stderr.on("data", (chunk: Buffer) => {
      if (!config.quiet) {
        if (!hasOutput) {
          stopTimer(timer)
          hasOutput = true
        }
        process.stderr.write(chunk)
      }
    })

    child.on("error", (err) => {
      stopTimer(timer)
      reject(new Error(`Failed to spawn claude: ${err.message}`))
    })

    child.on("close", (_code) => {
      stopTimer(timer)

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer.trim())
          if (event.type === "result") lastResult = event as ResultEvent
        } catch {
          // ignore
        }
      }

      if (lastResult) {
        resolve({
          role,
          output: lastResult.result ?? "",
          costUsd: lastResult.total_cost_usd ?? 0,
          durationMs: lastResult.duration_ms ?? 0,
          sessionId: lastResult.session_id ?? "",
          isError: lastResult.is_error ?? false,
        })
      } else {
        resolve({
          role,
          output: "",
          costUsd: 0,
          durationMs: 0,
          sessionId: "",
          isError: true,
        })
      }
    })
  })
}

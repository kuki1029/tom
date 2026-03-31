import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execSync } from "node:child_process"
import type { Memory, Learning } from "./types.js"

const MEMORY_PATH = path.join(os.homedir(), ".tom", "memory.json")

export const loadMemory = (): Memory => {
  if (!fs.existsSync(MEMORY_PATH)) return { learnings: [] }
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"))
    // Handle both { learnings: [...] } and plain array formats
    if (Array.isArray(raw)) return { learnings: raw }
    return raw?.learnings ? raw : { learnings: [] }
  } catch {
    return { learnings: [] }
  }
}

export const saveMemory = (memory: Memory): void => {
  const dir = path.dirname(MEMORY_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2))
}

export const detectProjectName = (cwd: string): string => {
  // Try the cwd itself first
  try {
    const url = execSync("git remote get-url origin", { cwd, stdio: "pipe" }).toString().trim()
    return path.basename(url).replace(/\.git$/, "")
  } catch {
    // Multi-repo workspace — check sub-dirs for a git remote
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const url = execSync("git remote get-url origin", { cwd: path.join(cwd, entry.name), stdio: "pipe" }).toString().trim()
          // Found a sub-repo — derive workspace name from the org (e.g. "joinergoai" → "Ergo")
          const repoName = path.basename(url).replace(/\.git$/, "")
          const parts = repoName.split("-")
          return parts[0] // e.g. "Ergo-Dashboard-Backend" → "Ergo"
        } catch { continue }
      }
    } catch { /* ignore */ }
    return path.basename(cwd)
  }
}

export const formatMemoryForPrompt = (memory: Memory, project?: string, limit = 15): string => {
  if (!memory.learnings.length) return ""

  const projectFirst = project
    ? [
        ...memory.learnings.filter(l => l.project === project),
        ...memory.learnings.filter(l => l.project !== project),
      ]
    : memory.learnings

  const recent = projectFirst.slice(-limit)
  const lines = recent.map(l => `- [${l.category}] ${l.learning}`)

  return [
    "",
    "## Learnings from Previous Runs",
    "",
    "These are mistakes and patterns discovered in previous runs. Avoid repeating them:",
    "",
    ...lines,
    "",
  ].join("\n")
}

// ========= Display =========

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"

export const printMemory = (filterProject?: string): void => {
  const memory = loadMemory()

  if (!memory.learnings.length) {
    console.log("  No learnings yet. Run a pipeline to start learning.\n")
    return
  }

  const filtered = filterProject
    ? memory.learnings.filter(l => l.project === filterProject)
    : memory.learnings

  if (!filtered.length) {
    console.log(`  No learnings for project "${filterProject}".\n`)
    return
  }

  // Group by project
  const byProject = new Map<string, typeof filtered>()
  for (const l of filtered) {
    const group = byProject.get(l.project) ?? []
    group.push(l)
    byProject.set(l.project, group)
  }

  for (const [project, learnings] of byProject) {
    console.log(`\n  ${CYAN}${project}${RESET} ${DIM}(${learnings.length} learnings)${RESET}`)
    for (const l of learnings) {
      const tag = `${DIM}[${l.category}]${RESET}`
      const date = `${DIM}${l.date}${RESET}`
      console.log(`    ${YELLOW}${l.id}${RESET} ${tag} ${l.learning} ${date}`)
    }
  }
  console.log()
}

export const printLastLearnings = (): void => {
  const memory = loadMemory()
  if (!memory.learnings.length) {
    console.log("  No learnings yet.\n")
    return
  }

  // Find the most recent date
  const lastDate = memory.learnings[memory.learnings.length - 1].date
  const last = memory.learnings.filter(l => l.date === lastDate)

  console.log(`\n  ${DIM}Learnings from ${lastDate}:${RESET}`)
  for (const l of last) {
    const tag = `${DIM}[${l.category}]${RESET}`
    console.log(`    ${YELLOW}${l.id}${RESET} ${tag} ${l.learning}`)
  }
  console.log()
}

export const addLearning = (learning: string, category: string, cwd: string): void => {
  const memory = loadMemory()
  const lastId = memory.learnings.length
    ? parseInt(memory.learnings[memory.learnings.length - 1].id.replace("L", ""))
    : 0
  const project = detectProjectName(cwd)

  memory.learnings.push({
    id: `L${lastId + 1}`,
    source: "interactive",
    project,
    task: "manual",
    date: new Date().toISOString().split("T")[0],
    learning,
    category: (["types", "patterns", "testing", "architecture", "style", "performance"].includes(category) ? category : "other") as Learning["category"],
  })

  saveMemory(memory)
  console.log(`  Added L${lastId + 1} [${category}]: ${learning}\n`)
}

export const deleteLearning = (id: string): void => {
  const memory = loadMemory()
  const before = memory.learnings.length
  memory.learnings = memory.learnings.filter(l => l.id !== id)
  if (memory.learnings.length === before) {
    console.log(`  Learning "${id}" not found.\n`)
  } else {
    saveMemory(memory)
    console.log(`  Deleted ${id}.\n`)
  }
}

export const clearMemory = (): void => {
  if (fs.existsSync(MEMORY_PATH)) {
    fs.unlinkSync(MEMORY_PATH)
    console.log("  Memory cleared.\n")
  } else {
    console.log("  No memory file to clear.\n")
  }
}

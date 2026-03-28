import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { AgentResult, Contract, Criterion, Critique } from "./types.js"
import { parseCritique, allPassed } from "./contract.js"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const WHITE = "\x1b[37m"

const SEPARATOR = `${DIM}${"─".repeat(60)}${RESET}`

const shortPath = (filePath: string): string =>
  filePath.replace(/^.*?\/(frontend|backend|automations)\//, "$1/")

export const printPhaseBanner = (phase: string): void => {
  const line = "═".repeat(60)
  console.log(`\n${BOLD}${CYAN}${line}${RESET}`)
  console.log(`${BOLD}${CYAN}  TOM — ${phase}${RESET}`)
  console.log(`${BOLD}${CYAN}${line}${RESET}\n`)
}

// Group criteria by verification type for clean display
const groupCriteria = (criteria: Criterion[]): Map<string, Criterion[]> => {
  const groups = new Map<string, Criterion[]>()
  for (const c of criteria) {
    const existing = groups.get(c.verification) ?? []
    existing.push(c)
    groups.set(c.verification, existing)
  }
  return groups
}

const verificationLabel = (v: string): { label: string; color: string } => {
  switch (v) {
    case "code_review": return { label: "code review", color: DIM }
    case "type_check": return { label: "type check", color: CYAN }
    case "test_run": return { label: "test", color: GREEN }
    case "build": return { label: "build", color: CYAN }
    case "browser": return { label: "browser", color: YELLOW }
    case "manual": return { label: "manual", color: DIM }
    default: return { label: v, color: DIM }
  }
}

export const printPlanSummary = (contract: Contract): void => {
  console.log(SEPARATOR)
  console.log(`${BOLD}${WHITE}  PLAN${RESET}`)
  console.log(SEPARATOR)
  console.log()
  console.log(`  ${BOLD}Task:${RESET} ${contract.task}`)
  console.log()

  // Scope — each file on its own line
  if (contract.scope.files_to_create.length) {
    console.log(`  ${GREEN}${BOLD}Create:${RESET}`)
    for (const f of contract.scope.files_to_create) {
      console.log(`    ${GREEN}+${RESET} ${shortPath(f)}`)
    }
  }
  if (contract.scope.files_to_modify.length) {
    console.log(`  ${YELLOW}${BOLD}Modify:${RESET}`)
    for (const f of contract.scope.files_to_modify) {
      console.log(`    ${YELLOW}~${RESET} ${shortPath(f)}`)
    }
  }
  if (contract.scope.files_to_delete.length) {
    console.log(`  ${RED}${BOLD}Delete:${RESET}`)
    for (const f of contract.scope.files_to_delete) {
      console.log(`    ${RED}-${RESET} ${shortPath(f)}`)
    }
  }

  // Criteria — grouped by verification type
  console.log()
  console.log(SEPARATOR)
  console.log(`  ${BOLD}${WHITE}  CRITERIA${RESET}`)
  console.log(SEPARATOR)

  const groups = groupCriteria(contract.criteria)
  for (const [type, criteria] of groups) {
    const { label, color } = verificationLabel(type)
    console.log(`\n  ${color}${BOLD}${label}${RESET}`)
    for (const c of criteria) {
      console.log(`    ${DIM}${c.id}${RESET}  ${c.description}`)
    }
  }

  // Sprints
  if (contract.sprints.length) {
    console.log()
    console.log(SEPARATOR)
    console.log(`  ${BOLD}${WHITE}  SPRINTS${RESET}`)
    console.log(SEPARATOR)
    console.log()
    for (const s of contract.sprints) {
      console.log(`  ${BOLD}${CYAN}${s.name}${RESET}`)
      console.log(`  ${s.description}`)
      console.log(`  ${DIM}Criteria: ${s.criteria_ids.join(", ")}${RESET}`)
      console.log()
    }
  }

  console.log(SEPARATOR)
  console.log()
}

export const printCritiqueSummary = (critique: Critique): void => {
  const verdictColor = critique.verdict === "PASS" ? GREEN : RED
  console.log()
  console.log(SEPARATOR)
  console.log(`  ${BOLD}  VERDICT: ${verdictColor}${critique.verdict}${RESET}`)
  console.log(SEPARATOR)
  console.log()

  for (const r of critique.results) {
    const icon = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`
    console.log(`  ${BOLD}${r.id}${RESET}  ${icon}`)
    console.log(`      ${DIM}${r.evidence}${RESET}`)
  }

  console.log()
}

export const printCostSummary = (results: AgentResult[]): void => {
  console.log(SEPARATOR)
  console.log(`  ${BOLD}${WHITE}  COST${RESET}`)
  console.log(SEPARATOR)
  console.log()

  const byRole = new Map<string, { cost: number; time: number; count: number }>()

  for (const r of results) {
    const existing = byRole.get(r.role) ?? { cost: 0, time: 0, count: 0 }
    existing.cost += r.costUsd
    existing.time += r.durationMs
    existing.count += 1
    byRole.set(r.role, existing)
  }

  for (const [role, data] of byRole) {
    const iterations = data.count > 1 ? ` (${data.count}x)` : ""
    const cost = `$${data.cost.toFixed(2)}`.padEnd(8)
    const time = formatDuration(data.time).padEnd(8)
    console.log(`  ${BOLD}${role.padEnd(12)}${RESET} ${cost} ${DIM}${time}${iterations}${RESET}`)
  }

  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0)
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0)

  console.log(`  ${"─".repeat(32)}`)
  console.log(`  ${BOLD}${"total".padEnd(12)}${RESET} $${totalCost.toFixed(2).padEnd(7)} ${DIM}${formatDuration(totalTime)}${RESET}`)
  console.log()
}

export const printStatus = (cwd: string): void => {
  const tomDir = path.join(cwd, ".tom")

  console.log()
  console.log(SEPARATOR)
  console.log(`  ${BOLD}${WHITE}  TOM STATUS${RESET}`)
  console.log(SEPARATOR)
  console.log()

  // Plan
  const hasPlan = fs.existsSync(path.join(tomDir, "plan.md"))
  console.log(`  ${hasPlan ? GREEN + "✓" : RED + "✗"}${RESET} plan.md`)

  // Contract
  const hasContract = fs.existsSync(path.join(tomDir, "contract.json"))
  if (hasContract) {
    try {
      const contract = JSON.parse(fs.readFileSync(path.join(tomDir, "contract.json"), "utf-8"))
      const count = contract.criteria?.length ?? 0
      const sprints = contract.sprints?.length ?? 0
      console.log(`  ${GREEN}✓${RESET} contract.json ${DIM}(${count} criteria, ${sprints} sprints)${RESET}`)
    } catch {
      console.log(`  ${YELLOW}?${RESET} contract.json ${DIM}(malformed)${RESET}`)
    }
  } else {
    console.log(`  ${RED}✗${RESET} contract.json`)
  }

  // Handoff
  const hasHandoff = fs.existsSync(path.join(tomDir, "handoff.md"))
  console.log(`  ${hasHandoff ? GREEN + "✓" : DIM + "·"}${RESET} handoff.md`)

  // Critique
  const hasCritique = fs.existsSync(path.join(tomDir, "critique.md"))
  if (hasCritique) {
    const critique = parseCritique(tomDir)
    const passed = critique.results.filter(r => r.passed).length
    const total = critique.results.length
    const color = allPassed(critique) ? GREEN : RED
    console.log(`  ${color}✓${RESET} critique.md ${DIM}— ${critique.verdict} (${passed}/${total})${RESET}`)
  } else {
    console.log(`  ${DIM}·${RESET} critique.md`)
  }

  // Review
  const hasReview = fs.existsSync(path.join(tomDir, "review.md"))
  console.log(`  ${hasReview ? GREEN + "✓" : DIM + "·"}${RESET} review.md`)

  // Branch
  try {
    const currentBranch = execSync("git branch --show-current", { cwd, stdio: "pipe" })
      .toString().trim()
    console.log()
    console.log(`  ${DIM}Branch:${RESET} ${currentBranch}`)
  } catch {
    // not in a git repo
  }

  console.log()
}

const formatDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

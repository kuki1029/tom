import fs from "node:fs"
import path from "node:path"
import type { Contract, Critique, CritiqueResult } from "./types.js"

export const parseContract = (tomDir: string): Contract => {
  const contractPath = path.join(tomDir, "contract.json")

  if (!fs.existsSync(contractPath)) {
    throw new Error(
      `Planner did not produce .tom/contract.json. Check planner output for errors.`
    )
  }

  const raw = fs.readFileSync(contractPath, "utf-8")
  const contract: Contract = JSON.parse(raw)

  if (!contract.task || !contract.criteria?.length) {
    throw new Error(
      `contract.json is malformed — missing "task" or "criteria" fields.`
    )
  }

  return contract
}

const parseResultsTable = (content: string): CritiqueResult[] => {
  const results: CritiqueResult[] = []
  const lines = content.split("\n")

  for (const line of lines) {
    const match = line.match(/^\|\s*(C\d+)\s*\|\s*(PASS|FAIL|SKIP)\s*\|\s*(.+?)\s*\|$/)
    if (match) {
      results.push({
        id: match[1],
        passed: match[2] === "PASS" || match[2] === "SKIP",
        evidence: match[3],
      })
    }
  }

  return results
}

export const parseCritique = (tomDir: string): Critique => {
  const critiquePath = path.join(tomDir, "critique.md")

  if (!fs.existsSync(critiquePath)) {
    return { verdict: "FAIL", results: [] }
  }

  const content = fs.readFileSync(critiquePath, "utf-8")
  const firstLine = content.split("\n")[0].trim()

  const verdict: Critique["verdict"] = firstLine.includes("PASS") ? "PASS" : "FAIL"
  const results = parseResultsTable(content)

  return { verdict, results }
}

export const allPassed = (critique: Critique): boolean =>
  critique.verdict === "PASS"

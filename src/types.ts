export interface Criterion {
  id: string
  description: string
  verification: "code_review" | "type_check" | "test_run" | "build" | "manual" | "browser"
  command?: string
}

export interface Sprint {
  name: string
  criteria_ids: string[]
  description: string
}

export interface Contract {
  task: string
  repos?: string[]
  scope: {
    files_to_create: string[]
    files_to_modify: string[]
    files_to_delete: string[]
  }
  criteria: Criterion[]
  sprints: Sprint[]
}

export interface AgentResult {
  role: AgentRole
  output: string
  costUsd: number
  durationMs: number
  sessionId: string
  isError: boolean
}

export type AgentRole = "discovery" | "planner" | "generator" | "evaluator" | "reviewer" | "pr"

export interface CritiqueResult {
  id: string
  passed: boolean
  evidence: string
}

export interface Critique {
  verdict: "PASS" | "FAIL"
  results: CritiqueResult[]
}

export interface Config {
  model: string
  maxIterations: number
  skipPlan: boolean
  planOnly: boolean
  noInteractive: boolean
  noBranch: boolean
  quiet: boolean
  continueRun: boolean
  noReview: boolean
  branchPrefix: string
  baseBranch: string
  repoBranches: Record<string, string>
  skipChat: boolean
  linearTeam?: string
  customPrompt?: string
  reviewCommand?: string
  mcpConfig?: string
  maxBudgetUsd?: number
}

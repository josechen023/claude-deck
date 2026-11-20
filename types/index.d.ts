/** A daily job's name, as the `jobs` option lists it. */
export type JobName = string

export type JobStatus = 'done' | 'failed'

/** One day's outcome per job, keyed by job. A job never run that day is absent. */
export type DayRecord = Partial<Record<JobName, JobStatus>>

/** Per-day job status, keyed by `YYYY-MM-DD` in the configured time zone. The only history kept. */
export type Daily = { days: Record<string, DayRecord> }

/** The pet's lifetime count of completed task-list items, across sessions. */
export type Life = { completed: number }

/**
 * The session's task list as counts. `tasks` maps a TaskCreate id to its status (ids only, never
 * text); `todo` holds TodoWrite's counts. `source` is the tool last seen, null before any.
 */
export type Progress = {
  source: 'todo' | 'task' | null
  todo: { done: number; total: number }
  tasks: Record<string, 'pending' | 'in_progress' | 'completed'>
}

export type Limit = { kind: string; pct: number; resetsAt: number | null }

export type Usage = { pct: number | null; limits: Limit[] }

export type Turn = {
  isRunning: boolean
  startedAt: number
  endedAt: number | null
  edits: number
  errors: number
  /** Failed calls in a row, reset by a call that succeeds. */
  errorStreak: number
}

/**
 * One line of the session log. `text` is built by the mod from job names, tool names, statuses and
 * counts only: never a path, command, input, prompt or task text.
 */
export type LogEntry = { at: number; kind: 'session' | 'job' | 'task' | 'turn' | 'error'; text: string }

/**
 * The session's model spend: the main loop's model and effort, and every request's tokens summed
 * (subagents' included), with the engine's cost estimate in US dollars.
 */
export type Spend = {
  model: string | null
  effort: string | null
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number | null
  hasUnknownPrice: boolean
  startedAt: number | null
}

/**
 * Estimated cost across sessions, kept in the store: US dollars per day (`YYYY-MM-DD`, last 30 days),
 * the running total since tracking began, and the day it began.
 */
export type Costs = { days: Record<string, number>; total: number; since: string | null }

/**
 * Background commands still running, keyed by the engine's task id: the daily jobs each one runs
 * (none for any other command) and when it started. Never the command itself.
 */
export type Background = Record<string, { jobs: JobName[]; startedAt: number }>

/** A short-lived pet reaction: a jump after a completed item, a worried tilt after an error. */
export type Flash = { kind: 'jump' | 'error'; at: number } | null

declare module 'claude-code' {
  interface PluginState {
    deck: {
      daily: Daily
      life: Life
      progress: Progress
      usage: Usage
      turn: Turn
      flash: Flash
      log: LogEntry[]
      spend: Spend
      costs: Costs
      /** This session's cost when last added to `costs`, so each reading adds only what is new. */
      costSeen: number | null
      bg: Background
    }
  }
}

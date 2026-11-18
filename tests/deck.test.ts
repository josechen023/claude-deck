import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  DEFAULT_PROGRESS,
  DEFAULT_TURN,
  CAT_FRAMES,
  DEFAULT_COSTS,
  DEFAULT_SPEND,
  addCost,
  costDelta,
  mergeCosts,
  normalizeCosts,
  weekCost,
  addRequest,
  cacheHitPct,
  fmtTokens,
  fmtUsd,
  shortModel,
  usdPerHour,
  FRAMES,
  LOG_MAX,
  headerDate,
  hhmm,
  pushLog,
  toolLabel,
  afterTaskCreate,
  afterTaskUpdate,
  afterTodoWrite,
  contextPct,
  dayKeyOf,
  paceOf,
  timePct,
  trackedSpan,
  dayLabel,
  gridDaysFor,
  monthDay,
  fmtResetIn,
  gridRow,
  jobsIn,
  lastDays,
  levelOf,
  limitOf,
  parseConfig,
  pendingToday,
  petStateOf,
  progressOf,
  prune,
  recordJob,
  reminderFor,
  todayLine,
  wallClock,
  windowsOf,
} from '../hooks/core'
import type { PetInputs } from '../hooks/core'
import type { Daily } from '../types'

// 2026-11-18 00:00 in Asia/Singapore (UTC+8) is 2026-11-17 16:00 UTC.
const JOBS_OPT = 'report=make report; backup=scripts/backup\\.sh; sync=rsync .*backup'
const OPTS = { options: { jobs: JOBS_OPT, timeZone: 'Asia/Singapore' } }
const NAMES = ['report', 'backup', 'sync']
const SGT_MIDNIGHT = Date.UTC(2026, 10, 17, 16, 0, 0)
const HOUR = 3_600_000

// ---------------------------------------------------------------- pet

const calm: PetInputs = {
  now: 1_000_000,
  turn: DEFAULT_TURN,
  flash: null,
  usage: { pct: 10, limits: [] },
  allDone: false,
  reminder: [],
}

test('the pet sleeps when idle and wags while Claude works', () => {
  expect(petStateOf(calm)).toBe('sleep')
  expect(petStateOf({ ...calm, turn: { ...DEFAULT_TURN, isRunning: true } })).toBe('wag')
})

test('the pet jumps for a few seconds after an item is completed', () => {
  const flash = { kind: 'jump' as const, at: calm.now }
  expect(petStateOf({ ...calm, flash })).toBe('jump')
  expect(petStateOf({ ...calm, flash, now: calm.now + 3_999 })).toBe('jump')
  expect(petStateOf({ ...calm, flash, now: calm.now + 4_000 })).toBe('sleep')
})

test('an error makes it worried, above everything else', () => {
  const failing = { ...DEFAULT_TURN, isRunning: true, errorStreak: 1 }
  expect(petStateOf({ ...calm, turn: failing })).toBe('worried')
  expect(petStateOf({ ...calm, flash: { kind: 'error', at: calm.now } })).toBe('worried')
  expect(petStateOf({ ...calm, turn: failing, reminder: ['backup'], usage: { pct: 99, limits: [] } })).toBe('worried')
})

test('all three jobs done makes it happy; high context or rate limit wins over that', () => {
  expect(petStateOf({ ...calm, allDone: true })).toBe('happy')
  expect(petStateOf({ ...calm, allDone: true, usage: { pct: 86, limits: [] } })).toBe('full')
  expect(petStateOf({ ...calm, usage: { pct: 85, limits: [] } })).toBe('sleep') // over 85, not at it
  const limits = [{ kind: 'five_hour', pct: 90, resetsAt: null }]
  expect(petStateOf({ ...calm, usage: { pct: 90, limits } })).toBe('tired') // rate limit before context
})

test('the reminder barks over everything but an error', () => {
  expect(petStateOf({ ...calm, reminder: ['backup'], turn: { ...DEFAULT_TURN, isRunning: true } })).toBe('bark')
  expect(petStateOf({ ...calm, reminder: ['backup'], usage: { pct: 99, limits: [{ kind: 'seven_day', pct: 99, resetsAt: null }] } })).toBe('bark')
})

test('every shiba and cat frame is four rows of 15 cells', () => {
  for (const [state, frames] of [...Object.entries(FRAMES), ...Object.entries(CAT_FRAMES)]) {
    for (const frame of frames) {
      expect(frame.length).toBe(4)
      for (const row of frame) {
        const width = [...row.map(r => r.text).join('')].length
        if (width !== 15) throw new Error(`${state} row "${row.map(r => r.text).join('')}" is ${width} cells`)
      }
    }
  }
})

test('the level grows with completed items: 5, then 10 more, then 15 more', () => {
  expect(levelOf(0)).toEqual({ level: 1, into: 0, need: 5 })
  expect(levelOf(4).level).toBe(1)
  expect(levelOf(5)).toEqual({ level: 2, into: 0, need: 10 })
  expect(levelOf(15).level).toBe(3)
  expect(levelOf(29).level).toBe(3)
  expect(levelOf(30).level).toBe(4)
})

// ---------------------------------------------------------------- daily

test('the day turns at midnight in the configured zone, not UTC', () => {
  expect(wallClock(SGT_MIDNIGHT - 1, 'Asia/Singapore')).toEqual({ key: '2026-11-17', hour: 23 })
  expect(wallClock(SGT_MIDNIGHT, 'Asia/Singapore')).toEqual({ key: '2026-11-18', hour: 0 })
  expect(wallClock(SGT_MIDNIGHT, 'UTC')).toEqual({ key: '2026-11-17', hour: 16 })
})

test('the grid is the last 7 days, oldest first, across a month boundary', () => {
  expect(lastDays('2026-12-02')).toEqual(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'])
})

test('the docked grid shows as many days as fit, 7 to 14, each with its date and weekday', () => {
  expect(gridDaysFor(46, 11)).toBe(12) // the default 50-column pane
  expect(gridDaysFor(20, 11)).toBe(7)
  expect(gridDaysFor(200, 11)).toBe(14)
  expect(dayLabel('2026-11-18')).toEqual({ dom: '18', wd: 'We', isWeekend: false })
  expect(dayLabel('2026-11-22')).toEqual({ dom: '22', wd: 'Su', isWeekend: true })
  expect(monthDay('2026-11-07')).toBe('11/07')
  expect(dayKeyOf('20261107')).toBe('2026-11-07')
  expect(dayKeyOf('2026-11-07')).toBe('2026-11-07')
  expect(dayKeyOf('20261131')).toBeNull()
  expect(dayKeyOf('yesterday')).toBeNull()
})

test('the grid shows only days since tracking began', () => {
  expect(trackedSpan({ days: {} }, '2026-11-18')).toBe(1)
  expect(trackedSpan({ days: { '2026-11-18': { backup: 'done' } } }, '2026-11-18')).toBe(1)
  expect(trackedSpan({ days: { '2026-11-15': { backup: 'done' }, '2026-11-17': {} } }, '2026-11-18')).toBe(4)
  expect(trackedSpan({ days: { '2026-10-30': { backup: 'done' } } }, '2026-11-02')).toBe(4)
})

test('rate-limit windows read against the time gone', () => {
  const now = Date.UTC(2026, 10, 18, 12)
  expect(timePct('5h', now + 2.5 * 3_600_000, now)).toBe(50)
  expect(timePct('week', now + 3.5 * 86_400_000, now)).toBe(50)
  expect(timePct('week', null, now)).toBeNull()
  expect(timePct('opus', now + 1000, now)).toBeNull()
  expect(paceOf(10, 50)).toEqual({ kind: 'under', gap: 40 })
  expect(paceOf(48, 50)).toEqual({ kind: 'on', gap: 2 })
  expect(paceOf(70, 50)).toEqual({ kind: 'over', gap: 20 })
})

test('the session log keeps the newest lines, local times, and tool names only', () => {
  let log = pushLog(undefined, { at: 0, kind: 'session', text: 'session started' })
  for (let i = 0; i < 20; i++) log = pushLog(log, { at: i, kind: 'turn', text: `turn ${i}` })
  expect(log.length).toBe(LOG_MAX)
  expect(log[LOG_MAX - 1]!.text).toBe('turn 19')
  expect(hhmm(Date.UTC(2026, 10, 18, 2, 5), 'Asia/Singapore')).toBe('10:05')
  expect(toolLabel('Bash')).toBe('Bash')
  expect(headerDate(Date.UTC(2026, 10, 18, 7, 24), 'Asia/Singapore')).toBe('Wed 11/18 15:24')
  expect(toolLabel('mcp__claude_ai_Gmail__send')).toBe('MCP tool')
})

test('model spend: short model ids, summed tokens, cache hit, cost and rate', () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus-5-5')
  expect(shortModel(null)).toBe('—')
  const req = { input_tokens: 100, output_tokens: 500, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }
  const s = addRequest(addRequest(DEFAULT_SPEND, req), req)
  expect([s.requests, s.input, s.output, s.cacheRead]).toEqual([2, 200, 1000, 1800])
  expect(cacheHitPct(s)).toBe(90)
  expect(cacheHitPct(DEFAULT_SPEND)).toBeNull()
  expect([fmtTokens(840), fmtTokens(1840), fmtTokens(18_400), fmtTokens(1_240_000)]).toEqual(['840', '1.8k', '18k', '1.2M'])
  expect([fmtUsd(0.4249), fmtUsd(12.3), fmtUsd(128.4)]).toEqual(['$0.42', '$12.30', '$128'])
  expect(usdPerHour(3, 0, 2 * 3_600_000)).toBe(1.5)
  expect(usdPerHour(3, 0, 60_000)).toBeNull()
})

test('estimated cost: per day, the last 7 days, and the total across sessions', () => {
  let c = addCost(DEFAULT_COSTS, '2026-11-10', 5)
  c = addCost(c, '2026-11-15', 2)
  c = addCost(c, '2026-11-18', 1.5)
  c = addCost(c, '2026-11-18', 0)
  expect(c.total).toBe(8.5)
  expect(c.since).toBe('2026-11-10')
  expect(weekCost(c, '2026-11-18')).toEqual({ usd: 3.5, days: 7 }) // 11/12-11/18
  expect(weekCost(addCost(DEFAULT_COSTS, '2026-11-18', 2), '2026-11-18')).toEqual({ usd: 2, days: 1 })
  expect(addCost(c, '2026-12-20', 1).days['2026-11-10']).toBeUndefined() // older than 30 days
  expect(mergeCosts(c, addCost(DEFAULT_COSTS, '2026-11-18', 4)).days['2026-11-18']).toBe(4)
  expect(normalizeCosts({ days: { bad: 1, '2026-11-18': -2, '2026-11-17': 3 }, total: 'x' })).toEqual({ days: { '2026-11-17': 3 }, total: 0, since: null })
  expect([costDelta(5, 3), costDelta(1, 3), costDelta(2, null)]).toEqual([2, 0, 2])
})

test('cells: green when done, red when missed or failed, gray only for today not yet run', () => {
  let d: Daily = { days: {} }
  d = recordJob(d, '2026-11-16', 'backup', 'done')
  d = recordJob(d, '2026-11-17', 'backup', 'failed')
  expect(gridRow(d, 'backup', '2026-11-18')).toEqual(['missed', 'missed', 'missed', 'missed', 'done', 'missed', 'pending'])
  d = recordJob(d, '2026-11-18', 'backup', 'failed')
  expect(gridRow(d, 'backup', '2026-11-18').at(-1)).toBe('missed')
  d = recordJob(d, '2026-11-18', 'backup', 'done')
  expect(gridRow(d, 'backup', '2026-11-18').at(-1)).toBe('done')
  // A later failure the same day does not undo a success.
  d = recordJob(d, '2026-11-18', 'backup', 'failed')
  expect(d.days['2026-11-18']?.backup).toBe('done')
})

test('the today line names what is pending', () => {
  let d: Daily = { days: {} }
  expect(todayLine(d, '2026-11-18', NAMES)).toBe('today 0/3 · report, backup, sync pending')
  d = recordJob(recordJob(d, '2026-11-18', 'report', 'done'), '2026-11-18', 'sync', 'done')
  expect(todayLine(d, '2026-11-18', NAMES)).toBe('today 2/3 · backup pending')
  d = recordJob(d, '2026-11-18', 'backup', 'done')
  expect(todayLine(d, '2026-11-18', NAMES)).toBe('all done today')
})

test('the reminder starts at the configured hour, names pending jobs, and can be off', () => {
  const d = recordJob({ days: {} }, '2026-11-18', 'report', 'done')
  expect(reminderFor(d, { key: '2026-11-18', hour: 15 }, 16, NAMES)).toEqual([])
  expect(reminderFor(d, { key: '2026-11-18', hour: 16 }, 16, NAMES)).toEqual(['backup', 'sync'])
  expect(reminderFor(d, { key: '2026-11-18', hour: 23 }, null, NAMES)).toEqual([])
  expect(parseConfig({ reminderHour: -1 }).reminderHour).toBe(null)
  expect(parseConfig({}).reminderHour).toBe(16)
})

test('history keeps 30 days', () => {
  let d: Daily = { days: {} }
  for (const day of lastDays('2026-11-18', 40)) d = recordJob(d, day, 'backup', 'done')
  const kept = Object.keys(prune(d, '2026-11-18').days).sort()
  expect(kept.length).toBe(30)
  expect(kept[0]).toBe('2026-10-20')
})

test('the jobs option: name=pattern entries, matched against Bash commands', () => {
  const { jobs } = parseConfig({ jobs: JOBS_OPT })
  expect(jobs.map(j => j.name)).toEqual(['report', 'backup', 'sync'])
  expect(jobsIn("bash ~/scripts/backup.sh --password 'x'", jobs)).toEqual(['backup'])
  expect(jobsIn('make report', jobs)).toEqual(['report'])
  expect(jobsIn('rsync -a ~/notes /mnt/backup', jobs)).toEqual(['sync'])
  expect(jobsIn('ls ~/Downloads', jobs)).toEqual([])
  // No jobs by default; bad entries skipped; a pattern that does not compile matches nothing.
  expect(parseConfig({}).jobs).toEqual([])
  expect(parseConfig({ jobs: 'Report=x; =y; no pattern; report=z; bad name=q' }).jobs.map(j => j.name)).toEqual(['report'])
  expect(jobsIn('backup', parseConfig({ jobs: 'backup=([' }).jobs)).toEqual([])
  expect(parseConfig({ jobs: 'a=1;b=2;c=3;d=4;e=5;f=6;g=7' }).jobs.length).toBe(6)
})

// ---------------------------------------------------------------- progress

test('progress from TodoWrite counts completed items and how many are new', () => {
  const a = afterTodoWrite(DEFAULT_PROGRESS, [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }])
  expect(progressOf(a.progress)).toEqual({ done: 1, total: 3 })
  expect(a.newlyDone).toBe(1)
  const b = afterTodoWrite(a.progress, [{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }])
  expect(b.newlyDone).toBe(1)
  expect(progressOf(afterTodoWrite(b.progress, []).progress)).toBe(null)
})

test('progress from TaskCreate / TaskUpdate tracks ids and status only', () => {
  let p = afterTaskCreate(afterTaskCreate(DEFAULT_PROGRESS, '1'), '2')
  expect(progressOf(p)).toEqual({ done: 0, total: 2 })
  const u = afterTaskUpdate(p, '1', 'completed')
  expect(u.newlyDone).toBe(1)
  p = u.progress
  expect(afterTaskUpdate(p, '1', 'completed').newlyDone).toBe(0) // already completed
  expect(progressOf(afterTaskUpdate(p, '2', 'deleted').progress)).toEqual({ done: 1, total: 1 })
  expect(progressOf(DEFAULT_PROGRESS)).toBe(null)
})

// ---------------------------------------------------------------- usage

test('usage: context percent, the 5h and weekly windows, time to reset', () => {
  expect(contextPct({ percent: 42, window: 200_000 })).toBe(42)
  expect(contextPct({ tokens: 50_000, window: 200_000 })).toBe(25)
  expect(contextPct({ window: 200_000 })).toBe(null)
  const limits = [
    limitOf({ kind: 'seven_day_opus', percentUsed: 50 }),
    limitOf({ kind: 'seven_day', percentUsed: 31, resetsAt: '1970-01-05T02:00:00.000Z' }),
    limitOf({ kind: 'five_hour', percentUsed: 12, resetsAt: '1970-01-01T03:10:00.000Z' }),
  ]
  expect(windowsOf(limits).map(w => [w.label, w.limit.pct])).toEqual([['5h', 12], ['week', 31]])
  expect(fmtResetIn(limits[2]!.resetsAt, 0)).toBe('3h10m')
  expect(fmtResetIn(limits[1]!.resetsAt, 0)).toBe('4d2h')
})

// ---------------------------------------------------------------- the module in an engine

const PANE = (placement: 'dock' | 'inline', bodyColumns = 44) => ({
  plugin: 'deck',
  component: 'Pane' as const,
  requestId: 'deck',
  props: {
    title: 'Deck',
    isFocused: false,
    bodyColumns,
    placement,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

/** Stands for the engine beneath the plugin. */
const engine = (on: On, now: number, store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now })
  // The plugin's store in memory, which the test reads back as `store`.
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, store }
}

/** A `/deck <args>` typed at the prompt. */
const deck = (args: string) => ({
  command: 'deck',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

const textOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')

const BACKUP = "bash ~/scripts/backup.sh --password 'secret'"

test('a successful backup run is recorded for today, and the pane never shows the command', OPTS, async ($, on) => {
  const { clock, store } = engine(on, SGT_MIDNIGHT + 10 * HOUR) // 10:00 local
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: BACKUP })
  await clock.advance(0)

  expect(store.daily).toEqual({ days: { '2026-11-18': { backup: 'done' } } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE('dock'), surface })
    const all = await textOf(ui)
    expect(all).toContain('today 1/3 · report, sync pending')
    expect(all).toContain('DAILY')
    expect(all).toContain('no task list')
    expect(all).toContain('SESSION LOG')
    expect(all).toContain('10:00  backup ✓ done')
    expect(all).toContain('SHIBA & NEKO')
    expect(all).toContain('D E C K')
    expect(all).toContain('MODEL')
    expect(all).toContain('daily 1/3')
    expect(all).not.toContain('backup.sh')
    expect(all).not.toContain('secret')
    await ui.unmount()
  }
})

test('a failing run marks the day failed; the hook passes the result on unchanged', OPTS, async ($, on) => {
  const { clock, store } = engine(on, SGT_MIDNIGHT + 10 * HOUR)
  const answer = { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true as const, text: 'Exit code 1' }
  on('tool.call', () => answer)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Bash', command: BACKUP })
  await clock.advance(0)
  expect(ran.isError).toBe(true)
  expect(ran.deny).toBe(undefined)
  expect(store.daily).toEqual({ days: { '2026-11-18': { backup: 'failed' } } })
})

test('the history from the store draws the grid, and the reminder barks from 16:00', OPTS, async ($, on) => {
  const { clock } = engine(on, SGT_MIDNIGHT + 15 * HOUR, {
    daily: { days: { '2026-11-17': { report: 'done', backup: 'done', sync: 'done' }, '2026-11-18': { report: 'done' } } },
    life: { completed: 7 },
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const before = await $.ui.mount({ ...PANE('dock'), surface: 'terminal' })
  expect(await textOf(before)).not.toContain('woof!')
  expect(await textOf(before)).toContain('Lv 2')
  await before.unmount()

  await clock.advance(HOUR) // 16:00 local
  const after = await $.ui.mount({ ...PANE('dock'), surface: 'terminal' })
  expect(await textOf(after)).toContain('woof! backup, sync are still pending')
  await after.unmount()
})

test('/deck done marks a job for today; /deck reset keeps the history', OPTS, async ($, on) => {
  const { store } = engine(on, SGT_MIDNIGHT + 9 * HOUR)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const done = await $.command.run(deck('done sync'))
  expect(done.text).toContain('Marked sync done for 2026-11-18')
  expect((await $.command.run(deck('done payroll'))).text).toContain('Usage')
  await $.command.run(deck('reset'))
  expect(store.daily).toEqual({ days: { '2026-11-18': { sync: 'done' } } })
})

test('completing task items fills progress, grows the pet, and is persisted', OPTS, async ($, on) => {
  const { clock, store } = engine(on, SGT_MIDNIGHT + 9 * HOUR, { life: { completed: 4 } })
  let n = 0
  on('tool.call', (_$, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++n), subject: 'x' } } } : { result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'secret task text', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'other', description: 'd' })
  await clock.advance(0)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await clock.advance(0)

  expect(store.life).toEqual({ completed: 5 })
  const ui = await $.ui.mount({ ...PANE('dock'), surface: 'terminal' })
  const all = await textOf(ui)
  expect(all).toContain('1/2')
  expect(all).toContain('Lv 2')
  expect(all).not.toContain('secret task text')
  await ui.unmount()
})

test('inline (not fullscreen) the pane is a two-row summary', OPTS, async ($, on) => {
  engine(on, SGT_MIDNIGHT + 9 * HOUR)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE('inline', 80), surface })
    const root = (await ui.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length).toBe(2)
    const all = await textOf(ui)
    expect(all).toContain('SHIBA')
    expect(all).toContain('no task list')
    expect(all).toContain('today 0/3')
    await ui.unmount()
  }
})

test('the pet name is an option', { options: { petName: 'MOCHI', timeZone: 'Asia/Singapore' } }, async ($, on) => {
  engine(on, SGT_MIDNIGHT)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE('dock'), surface: 'terminal' })
  expect(await textOf(ui)).toContain('MOCHI')
  await ui.unmount()
})

test('no jobs by default: the grid says so and the pet is not happy for nothing', async ($, on) => {
  engine(on, SGT_MIDNIGHT + 9 * HOUR)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE('dock'), surface: 'terminal' })
  const all = await textOf(ui)
  expect(all).toContain('no daily jobs set')
  expect(all).not.toContain('daily 0/0')
  expect(all).toContain('asleep')
  expect((await $.command.run(deck('done backup'))).text).toContain('No daily jobs are set')
  await ui.unmount()
})

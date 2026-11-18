// Pure logic for Deck: config, the daily grid and its day boundary, the reminder, the pet's state,
// task-list progress and the usage gauges. Nothing here touches `$`, so the tests drive it directly.
import type { Costs, Daily, DayRecord, Flash, JobStatus, Limit, Life, LogEntry, Progress, Spend, Turn, Usage } from '../types'

/** The most daily jobs the `jobs` option may list. */
export const MAX_JOBS = 6
export const KEEP_DAYS = 30
export const GRID_DAYS = 7

// ---------------------------------------------------------------- defaults

export const DEFAULT_DAILY: Daily = { days: {} }
export const DEFAULT_LIFE: Life = { completed: 0 }
export const DEFAULT_PROGRESS: Progress = { source: null, todo: { done: 0, total: 0 }, tasks: {} }
export const DEFAULT_USAGE: Usage = { pct: null, limits: [] }
export const DEFAULT_SPEND: Spend = {
  model: null,
  effort: null,
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  usd: null,
  hasUnknownPrice: false,
  startedAt: null,
}
export const DEFAULT_TURN: Turn = { isRunning: false, startedAt: 0, endedAt: null, edits: 0, errors: 0, errorStreak: 0 }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored object merged over its defaults, so a value saved under an older shape still reads. */
export const normalize = <T extends object>(def: T, stored: unknown): T => (isObject(stored) ? ({ ...def, ...stored } as T) : def)

// ---------------------------------------------------------------- config

export type Config = {
  petName: string
  catName: string
  motion: boolean
  timeZone: string
  /** Hour (0-23) the reminder starts; null when disabled. */
  reminderHour: number | null
  /** The daily jobs, in the order the option lists them; none when the option is empty. */
  jobs: Job[]
  paneColumns: number
  openOnStart: boolean
}

/** A daily job: its name, and the pattern a Bash command must match to count as running it. */
export type Job = { name: string; pattern: RegExp | null }

/** A job's name: a letter or digit, then letters, digits, `-` or `_`, 16 at most. */
export const JOB_NAME = /^[a-z0-9][a-z0-9_-]{0,15}$/

/**
 * The `jobs` option, `name=pattern; name=pattern`, as jobs: names lowercased, an entry without a
 * valid name or `=` skipped, a repeated name kept once, at most MAX_JOBS.
 */
export const parseJobs = (source: string): Job[] => {
  const out: Job[] = []
  for (const entry of source.split(';')) {
    const at = entry.indexOf('=')
    if (at < 0) continue
    const name = entry.slice(0, at).trim().toLowerCase()
    if (!JOB_NAME.test(name) || out.some(j => j.name === name)) continue
    out.push({ name, pattern: compile(entry.slice(at + 1).trim()) })
    if (out.length === MAX_JOBS) break
  }
  return out
}

/** A pattern that does not compile matches nothing, rather than failing the module. */
export const compile = (source: string): RegExp | null => {
  if (!source.trim()) return null
  try {
    return new RegExp(source, 'i')
  } catch {
    return null
  }
}

export const parseConfig = (o: Readonly<Record<string, unknown>>): Config => {
  const str = (k: string, d: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : d)
  const num = (k: string, d: number) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : d)
  const hour = Math.round(num('reminderHour', 16))
  return {
    petName: str('petName', 'SHIBA').slice(0, 16),
    catName: str('catName', 'NEKO').slice(0, 16),
    motion: o.motion !== 'off',
    timeZone: str('timeZone', 'UTC'),
    reminderHour: hour >= 0 && hour <= 23 ? hour : null,
    jobs: parseJobs(str('jobs', '')),
    paneColumns: Math.max(32, Math.round(num('paneColumns', 50))),
    openOnStart: o.openOnStart !== false,
  }
}

/** The jobs a shell command runs, by the configured patterns. */
export const jobsIn = (command: string, jobs: readonly Job[]): string[] =>
  jobs.filter(j => j.pattern?.test(command) ?? false).map(j => j.name)

// ---------------------------------------------------------------- time zone and days

/** UTC offset (minutes) used when the engine has no Intl time zone data. */
const FALLBACK_OFFSET_MIN = 0

type Wall = { key: string; hour: number }

/** The calendar day (`YYYY-MM-DD`) and hour at `ms` in `timeZone`. */
export const wallClock = (ms: number, timeZone: string): Wall => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    const key = `${get('year')}-${get('month')}-${get('day')}`
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return { key, hour: Number(get('hour')) % 24 }
  } catch {
    // fall through to the fixed offset
  }
  const d = new Date(ms + FALLBACK_OFFSET_MIN * 60_000)
  return { key: d.toISOString().slice(0, 10), hour: d.getUTCHours() }
}

/** `key` moved by `delta` calendar days. */
export const shiftDay = (key: string, delta: number) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10)
}

/** The last `n` day keys ending today, oldest first. */
export const lastDays = (today: string, n = GRID_DAYS) => Array.from({ length: n }, (_, i) => shiftDay(today, i - (n - 1)))

/** Columns one day takes in the docked grid: a two-wide tile or label and a gap. */
export const CELL_W = 3
export const MAX_GRID_DAYS = 14

/** How many days fit in `columns` beside a `nameW`-wide name column: at least GRID_DAYS, at most MAX_GRID_DAYS. */
export const gridDaysFor = (columns: number, nameW: number) =>
  Math.max(GRID_DAYS, Math.min(MAX_GRID_DAYS, Math.floor((columns - nameW + 1) / CELL_W)))

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/** A day key's day of month (`05`), two-letter weekday (`We`) and whether it falls on a weekend. */
export const dayLabel = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
  return { dom: key.slice(8, 10), wd: WEEKDAYS[wd]!, isWeekend: wd === 0 || wd === 6 }
}

/** `20261105` or `2026-11-05` as the day key `2026-11-05`, or null when it is not a real date. */
export const dayKeyOf = (text: string): string | null => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text.trim())
  if (!m) return null
  const key = `${m[1]}-${m[2]}-${m[3]}`
  return shiftDay(key, 0) === key ? key : null
}

/** Days the grid has data for: from the first recorded day through today, at least 1. */
export const trackedSpan = (daily: Daily, today: string) => {
  const first = Object.keys(daily.days).filter(k => k <= today).sort()[0]
  if (!first) return 1
  const ms = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)))
  return Math.round((ms(today) - ms(first)) / 86_400_000) + 1
}

/** `2026-11-05` as `11/05`. */
export const monthDay = (key: string) => `${key.slice(5, 7)}/${key.slice(8, 10)}`

/** Done beats failed: a job that succeeded once that day stays done. */
const merge = (a: JobStatus | undefined, b: JobStatus | undefined): JobStatus | undefined =>
  a === 'done' || b === 'done' ? 'done' : (a ?? b)

/** Records one outcome for `job` on `day`, and drops days older than KEEP_DAYS. */
export const recordJob = (daily: Daily, day: string, job: string, status: JobStatus): Daily =>
  prune({ days: { ...daily.days, [day]: { ...daily.days[day], [job]: merge(daily.days[day]?.[job], status) } } }, day)

/** Two histories as one (another session may have written the store meanwhile). */
export const mergeDaily = (a: Daily, b: Daily): Daily => {
  const days: Record<string, DayRecord> = { ...a.days }
  for (const [day, rec] of Object.entries(b.days)) {
    const out: DayRecord = { ...days[day] }
    for (const j of Object.keys(rec)) {
      const s = merge(out[j], rec[j])
      if (s) out[j] = s
    }
    days[day] = out
  }
  return { days }
}

export const prune = (daily: Daily, today: string): Daily => {
  const oldest = shiftDay(today, -(KEEP_DAYS - 1))
  return { days: Object.fromEntries(Object.entries(daily.days).filter(([d]) => d >= oldest && d <= shiftDay(today, 1))) }
}

/** A stored history, keeping only well-formed days and statuses. */
export const normalizeDaily = (stored: unknown): Daily => {
  const days: Record<string, DayRecord> = {}
  const raw = isObject(stored) && isObject(stored.days) ? stored.days : {}
  for (const [day, rec] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(rec)) continue
    const out: DayRecord = {}
    for (const [j, v] of Object.entries(rec)) if (JOB_NAME.test(j) && (v === 'done' || v === 'failed')) out[j] = v
    days[day] = out
  }
  return { days }
}

export type Cell = 'done' | 'missed' | 'pending'

/** One job's row of cells, oldest first: done, missed (not run or failed), or pending (today, not done yet). */
export const gridRow = (daily: Daily, job: string, today: string, n = GRID_DAYS): Cell[] =>
  lastDays(today, n).map(day => {
    const s = daily.days[day]?.[job]
    if (s === 'done') return 'done'
    return day === today && s === undefined ? 'pending' : 'missed'
  })

export const pendingToday = (daily: Daily, today: string, jobs: readonly string[]): string[] =>
  jobs.filter(j => daily.days[today]?.[j] !== 'done')

/** `today 2/3 · backup pending`, or `all done today`. */
export const todayLine = (daily: Daily, today: string, jobs: readonly string[]) => {
  if (jobs.length === 0) return 'no daily jobs set'
  const pending = pendingToday(daily, today, jobs)
  if (pending.length === 0) return 'all done today'
  return `today ${jobs.length - pending.length}/${jobs.length} · ${pending.join(', ')} pending`
}

/** The pending jobs to bark about, or none before the reminder hour or when it is off. */
export const reminderFor = (daily: Daily, wall: Wall, reminderHour: number | null, jobs: readonly string[]): string[] =>
  reminderHour === null || wall.hour < reminderHour ? [] : pendingToday(daily, wall.key, jobs)

// ---------------------------------------------------------------- task list

type TaskStatus = Progress['tasks'][string]
type Todo = { status?: unknown }

export const progressOf = (p: Progress): { done: number; total: number } | null => {
  if (p.source === 'todo') return p.todo.total > 0 ? p.todo : null
  if (p.source === 'task') {
    const all = Object.values(p.tasks)
    return all.length > 0 ? { done: all.filter(s => s === 'completed').length, total: all.length } : null
  }
  return null
}

/** A TodoWrite call: the list's counts, and how many items it newly completed. */
export const afterTodoWrite = (p: Progress, todos: unknown): { progress: Progress; newlyDone: number } => {
  const list = Array.isArray(todos) ? (todos as Todo[]) : []
  const done = list.filter(t => t?.status === 'completed').length
  const before = p.source === 'todo' ? p.todo.done : 0
  return { progress: { ...p, source: 'todo', todo: { done, total: list.length } }, newlyDone: Math.max(0, done - before) }
}

export const afterTaskCreate = (p: Progress, id: unknown): Progress =>
  typeof id === 'string' && id ? { ...p, source: 'task', tasks: { ...p.tasks, [id]: 'pending' } } : p

/** A TaskUpdate call: its status change, and whether it completed the item. */
export const afterTaskUpdate = (p: Progress, id: unknown, status: unknown): { progress: Progress; newlyDone: number } => {
  if (typeof id !== 'string' || !id) return { progress: p, newlyDone: 0 }
  const tasks = { ...p.tasks }
  const before = tasks[id]
  if (status === 'deleted') delete tasks[id]
  else if (status === 'pending' || status === 'in_progress' || status === 'completed') tasks[id] = status as TaskStatus
  else if (before === undefined) tasks[id] = 'pending'
  return {
    progress: { ...p, source: 'task', tasks },
    newlyDone: status === 'completed' && before !== 'completed' ? 1 : 0,
  }
}

// ---------------------------------------------------------------- pet

/** Level 1 at zero; each level needs five more completed items than the last (5, 15, 30, 50 …). */
export const levelOf = (completed: number) => {
  let level = 1
  let need = 5
  let left = Math.max(0, Math.floor(completed))
  while (left >= need) {
    left -= need
    level += 1
    need += 5
  }
  return { level, into: left, need }
}

export type PetState = 'sleep' | 'wag' | 'jump' | 'worried' | 'happy' | 'full' | 'tired' | 'bark'

export const FLASH_MS = { jump: 4_000, error: 20_000 } as const
export const HIGH_PCT = 85

export type PetInputs = {
  now: number
  turn: Turn
  flash: Flash
  usage: Usage
  allDone: boolean
  reminder: string[]
}

/** The one state the pet shows, highest first: error, reminder, rate limit, context, jump, working, all done, asleep. */
export const petStateOf = (x: PetInputs): PetState => {
  const flashing = (kind: 'jump' | 'error') => x.flash?.kind === kind && x.now - x.flash.at < FLASH_MS[kind]
  if ((x.turn.isRunning && x.turn.errorStreak > 0) || flashing('error')) return 'worried'
  if (x.reminder.length > 0) return 'bark'
  if (x.usage.limits.some(l => l.pct > HIGH_PCT)) return 'tired'
  if (x.usage.pct !== null && x.usage.pct > HIGH_PCT) return 'full'
  if (flashing('jump')) return 'jump'
  if (x.turn.isRunning) return 'wag'
  if (x.allDone) return 'happy'
  return 'sleep'
}

/** The ms until a flash ends, so the pane can redraw then; null when none is showing. */
export const flashLeft = (flash: Flash, now: number): number | null => {
  if (!flash) return null
  const left = FLASH_MS[flash.kind] - (now - flash.at)
  return left > 0 ? left : null
}

/**
 * A run of a frame row: text, and either a theme role for its colour (`tongue`, `mark`) or raw
 * colours (`fg`, `bg`) where the pixel art paints itself.
 */
export type Run = { text: string; role?: 'tongue' | 'mark'; fg?: string; bg?: string }
export type Frame = Run[][]

const r = (text: string, role?: Run['role']): Run => (role ? { text, role } : { text })

/** The pets' frames: a sound line over five rows of sprite, all 15 cells wide. */
export const PET_W = 15
export const PET_H = 6

/**
 * A pose in pixels: ten rows of 15, two to a terminal row as half blocks (▀ ▄ █), each letter a
 * colour of the animal's palette and `.` empty. `face` gives the five sprite rows' glyphs drawn
 * on the fur: `L` and `R` the eyes, `N` the nose or mouth, a space none.
 */
type Pose = { px: string[]; face: string[] }
type Animal = { pal: Record<string, string>; sit: Pose; wag: Pose; lie: Pose; nose: string; call: [string, string] }

/** The eyes' and nose's ink. */
const INK = '#3B2A20'

const SIT_FACE = ['', '   L   R', '     N', '', '']
const LIE_FACE = ['', '', '   L   R', '     N', '']

/**
 * The shiba: an original drawing, chibi and sitting. Pointed ears with cream insides, a cream
 * muzzle and chest, pink cheeks and a tail curled over the back.
 */
const SHIBA: Animal = {
  pal: { o: '#E8913A', c: '#FFF1DC', p: '#FF96A5' },
  nose: 'ᴥ',
  call: ['woof!', 'woof! woof!'],
  sit: {
    face: SIT_FACE,
    px: [
      '.oo.....oo.....',
      '.oco...oco.....',
      'ooooooooooo....',
      'ooooooooooo....',
      'occccccccco.oo.',
      'opcccccccpooco.',
      '.occcccccoooo..',
      '..occccooooooo.',
      '..occccooooooo.',
      '..cc.cc..cc.cc.',
    ],
  },
  wag: {
    face: SIT_FACE,
    px: [
      '.oo.....oo.....',
      '.oco...oco.....',
      'ooooooooooo....',
      'ooooooooooo..o.',
      'occccccccco.ooo',
      'opcccccccpoooc.',
      '.occcccccoooo..',
      '..occccooooooo.',
      '..occccooooooo.',
      '..cc.cc..cc.cc.',
    ],
  },
  lie: {
    face: LIE_FACE,
    px: [
      '...............',
      '...............',
      '.oo.....oo.....',
      '.oco...oco.....',
      'ooooooooooo....',
      'ooooooooooooooo',
      'occccccccccoocc',
      'opcccccccpooooo',
      '.occcccccoooooo',
      '..cc.cc..ccc.cc',
    ],
  },
}

/**
 * The cat beside the shiba: an original drawing, a grey tabby with pink ears, a white muzzle,
 * chest and paws, stripes on the forehead and back, and a tail held up.
 */
const CAT: Animal = {
  pal: { g: '#A0A8BA', G: '#70778A', w: '#F6F3EE', r: '#F08CA0' },
  nose: 'ω',
  call: ['meow!', 'meow~ meow'],
  sit: {
    face: SIT_FACE,
    px: [
      '.g.......g.....',
      '.rg.....gr.....',
      'ggggGgGgggg....',
      'ggggggggggg..g.',
      'gwwwwwwwwwg..g.',
      'grwwwwwwwrg..g.',
      '.gwwwwwwwg..g..',
      '..gwwwwgGgGg...',
      '..gwwwwggggg...',
      '..ww.ww..ww....',
    ],
  },
  wag: {
    face: SIT_FACE,
    px: [
      '.g.......g.....',
      '.rg.....gr.....',
      'ggggGgGgggg....',
      'ggggggggggg...g',
      'gwwwwwwwwwg..g.',
      'grwwwwwwwrg..g.',
      '.gwwwwwwwg..g..',
      '..gwwwwgGgGg...',
      '..gwwwwggggg...',
      '..ww.ww..ww....',
    ],
  },
  lie: {
    face: LIE_FACE,
    px: [
      '...............',
      '...............',
      '.g.......g.....',
      '.rg.....gr.....',
      'ggggGgGgggg....',
      'gggggggggggGgGg',
      'gwwwwwwwwwggggg',
      'grwwwwwwwrggggg',
      '.gwwwwwwwgggggg',
      '..ww.ww..ww.wgg',
    ],
  },
}

/** One terminal row of a pose: two pixel rows as half blocks, the face's glyphs on the fur. */
const paintRow = (pal: Record<string, string>, top: string, bottom: string, glyphs: string[]): Run[] => {
  const runs: Run[] = []
  for (let i = 0; i < PET_W; i++) {
    const t = top[i] ?? '.'
    const b = bottom[i] ?? '.'
    const g = glyphs[i] ?? ' '
    const cell: Run =
      g !== ' '
        ? { text: g, fg: INK, bg: pal[t] ?? pal[b] }
        : t === '.' && b === '.'
          ? { text: ' ' }
          : b === '.'
            ? { text: '▀', fg: pal[t] }
            : t === '.'
              ? { text: '▄', fg: pal[b] }
              : t === b
                ? { text: '█', fg: pal[t] }
                : { text: '▀', fg: pal[t], bg: pal[b] }
    const last = runs[runs.length - 1]
    if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text
    else runs.push(cell)
  }
  return runs
}

/**
 * A frame: the sound line, then the pose with these eyes and nose. With no sound line the pose
 * rises a row into its place, for the second frame of a jump.
 */
const paint = (a: Animal, pose: Pose, l: string, rt: string, n: string, sound: Run[] | null): Frame => {
  const sprite: Frame = []
  for (let row = 0; row < PET_H - 1; row++) {
    const face = [...(pose.face[row] ?? '').replace('L', l).replace('R', rt).replace('N', n)]
    sprite.push(paintRow(a.pal, pose.px[row * 2], pose.px[row * 2 + 1], face))
  }
  return sound ? [sound, ...sprite] : [...sprite, [r(' '.repeat(PET_W))]]
}

const line = (text: string): Run[] => [r(text.padEnd(PET_W))]
const loud = (text: string): Run[] => [r('  '), r(text, 'mark'), r(' '.repeat(PET_W - 2 - text.length))]

/** Every state's two frames for one animal. */
const framesOf = (a: Animal): Record<PetState, [Frame, Frame]> => {
  const f = (pose: Pose, l: string, rt: string, sound: Run[] | null, n = a.nose) => paint(a, pose, l, rt, n, sound)
  return {
    sleep: [f(a.lie, '-', '-', line('          z')), f(a.lie, '-', '-', line('          z z'))],
    wag: [f(a.sit, '•', '•', line('')), f(a.wag, '•', '•', line(''))],
    jump: [f(a.sit, '^', '^', line('       !')), f(a.wag, '^', '^', null)],
    worried: [f(a.sit, '°', '°', line('         ?')), f(a.sit, '°', '°', line('          ?'))],
    happy: [f(a.sit, '^', '^', line('     ♪')), f(a.wag, '^', '^', line('        ♪'))],
    full: [f(a.sit, '=', '=', line('          .')), f(a.sit, '=', '=', line('          . .'))],
    tired: [f(a.lie, '˘', '˘', line('     ;')), f(a.lie, '˘', '˘', line('      ;'))],
    bark: [f(a.sit, '>', '<', loud(a.call[0]), 'O'), f(a.wag, '>', '<', loud(a.call[1]), 'o')],
  }
}

/** The shiba, two frames per state, six rows of 15 cells. */
export const FRAMES: Record<PetState, [Frame, Frame]> = framesOf(SHIBA)

/** The cat beside the shiba, the same states and size as the shiba's. */
export const CAT_FRAMES: Record<PetState, [Frame, Frame]> = framesOf(CAT)

/** How fast each state's two frames alternate, in ms. */
export const FRAME_MS: Record<PetState, number> = {
  sleep: 1400,
  wag: 260,
  jump: 320,
  worried: 900,
  happy: 600,
  full: 1600,
  tired: 1800,
  bark: 450,
}

/** The face alone, for the inline summary and where the animation cannot draw. */
export const FACE: Record<PetState, string> = {
  sleep: '-ᴥ-',
  wag: '^ᴥ^',
  jump: '^ᴥ^',
  worried: '°ᴥ°',
  happy: '^ᴥ^',
  full: '=ᴥ=',
  tired: '˘ᴥ˘',
  bark: '^O^',
}

/** The cat's face alone, where the animation cannot draw. */
export const CAT_FACE: Record<PetState, string> = {
  sleep: '-.-',
  wag: 'o.o',
  jump: '^.^',
  worried: 'o.O',
  happy: '^w^',
  full: '=.=',
  tired: '-.-',
  bark: '^O^',
}

/** One word for the state, shown beside the name where there is no animation to say it. */
export const MOOD: Record<PetState, string> = {
  sleep: 'asleep',
  wag: 'working',
  jump: 'yay',
  worried: 'worried',
  happy: 'happy',
  full: 'full',
  tired: 'tired',
  bark: 'woof!',
}

// ---------------------------------------------------------------- usage

/** A rate-limit reading, its ISO reset time turned into ms since the epoch. (From Flightdeck.) */
export const limitOf = (x: { kind: string; percentUsed: number; resetsAt?: string }): Limit => {
  const at = x.resetsAt ? Date.parse(x.resetsAt) : NaN
  return { kind: x.kind, pct: x.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

/** The context fill: the host's percent, else tokens over the window; null without a reading. */
export const contextPct = (c: { percent?: number; tokens?: number; window: number }): number | null =>
  typeof c.percent === 'number' ? c.percent : typeof c.tokens === 'number' && c.window > 0 ? (c.tokens * 100) / c.window : null

/** The 5-hour and weekly windows, in that order, when the host reports them. */
export const windowsOf = (limits: Limit[]): { label: string; limit: Limit }[] => {
  const five = limits.find(l => /five|5h/i.test(l.kind))
  const week = limits.find(l => /seven|7d|week/i.test(l.kind) && !/opus|sonnet/i.test(l.kind))
  return [five ? { label: '5h', limit: five } : null, week ? { label: 'week', limit: week } : null].filter(
    (x): x is { label: string; limit: Limit } => x !== null,
  )
}

/** How long each rate-limit window runs, by its label. */
export const WINDOW_MS: Record<string, number> = { '5h': 5 * 3_600_000, week: 7 * 86_400_000 }

/** Percent of a window's time already gone, from its reset time; null when unknown. */
export const timePct = (label: string, resetsAt: number | null | undefined, now: number): number | null => {
  const len = WINDOW_MS[label]
  if (!len || resetsAt === null || resetsAt === undefined) return null
  return Math.max(0, Math.min(100, (1 - (resetsAt - now) / len) * 100))
}

/** Usage against time gone: under pace leaves room, over pace runs out early; within 5 points is on pace. */
export const paceOf = (used: number, time: number): { kind: 'under' | 'on' | 'over'; gap: number } => {
  const gap = Math.round(time - used)
  return { kind: gap > 5 ? 'under' : gap < -5 ? 'over' : 'on', gap: Math.abs(gap) }
}

/** Time left until a window resets, its two largest units: `25m`, `3h10m`, `4d2h`; empty when unknown or past. (From Flightdeck.) */
export const fmtResetIn = (resetsAt: number | null | undefined, now: number) => {
  if (resetsAt === null || resetsAt === undefined || resetsAt <= now) return ''
  const m = Math.max(1, Math.floor((resetsAt - now) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${h}h`
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** A gauge of `width` cells: ▰ filled, ▱ empty. (From Flightdeck.) */
export const gauge = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '▰'.repeat(full), off: '▱'.repeat(width - full) }
}

// ---------------------------------------------------------------- model spend

/** `claude-opus-5-5` as `opus-5-5`, `claude-sonnet-4-5-20250929` as `sonnet-4-5`. */
export const shortModel = (id: string | null | undefined) =>
  id ? id.replace(/^(us\.|eu\.)?(anthropic\.)?claude-/, '').replace(/-\d{8}(-v\d+(:\d+)?)?$/, '').replace(/\[.*\]$/, '') : '—'

/** One finished request's usage added to the spend. */
export const addRequest = (
  s: Spend,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): Spend => ({
  ...s,
  requests: s.requests + 1,
  input: s.input + (u.input_tokens || 0),
  output: s.output + (u.output_tokens || 0),
  cacheRead: s.cacheRead + (u.cache_read_input_tokens || 0),
  cacheWrite: s.cacheWrite + (u.cache_creation_input_tokens || 0),
})

/** Share of input tokens the prompt cache served, 0-100; null before any input. */
export const cacheHitPct = (s: Spend): number | null => {
  const all = s.input + s.cacheRead + s.cacheWrite
  return all > 0 ? (s.cacheRead * 100) / all : null
}

/** A token count in three characters or so: `840`, `18.4k`, `1.2M`. */
export const fmtTokens = (n: number) =>
  n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`

/** Dollars: `$0.42`, `$12.30`, `$128`. */
export const fmtUsd = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

/** Dollars per hour since `startedAt`; null within the first five minutes, when the rate means little. */
export const usdPerHour = (usd: number | null, startedAt: number | null, now: number): number | null =>
  usd === null || startedAt === null || now - startedAt < 5 * 60_000 ? null : usd / ((now - startedAt) / 3_600_000)

// ---------------------------------------------------------------- cost history

export const DEFAULT_COSTS: Costs = { days: {}, total: 0, since: null }

/** A stored cost history, keeping only well-formed days and amounts. */
export const normalizeCosts = (stored: unknown): Costs => {
  const o = isObject(stored) ? stored : {}
  const days: Record<string, number> = {}
  if (isObject(o.days))
    for (const [k, v] of Object.entries(o.days)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && v >= 0) days[k] = v
  const total = typeof o.total === 'number' && o.total >= 0 ? o.total : 0
  const since = typeof o.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.since) ? o.since : null
  return { days, total, since }
}

/** `usd` more spent on `day`: added to that day and the total; days older than KEEP_DAYS dropped. */
export const addCost = (c: Costs, day: string, usd: number): Costs => {
  if (!(usd > 0)) return c
  const oldest = shiftDay(day, -(KEEP_DAYS - 1))
  const days = Object.fromEntries(Object.entries({ ...c.days, [day]: (c.days[day] ?? 0) + usd }).filter(([d]) => d >= oldest))
  return { days, total: c.total + usd, since: c.since ?? day }
}

/** Two cost histories as one, taking the larger figure for each day and for the total. */
export const mergeCosts = (a: Costs, b: Costs): Costs => {
  const days: Record<string, number> = { ...a.days }
  for (const [d, v] of Object.entries(b.days)) days[d] = Math.max(days[d] ?? 0, v)
  const since = a.since && b.since ? (a.since < b.since ? a.since : b.since) : (a.since ?? b.since)
  return { days, total: Math.max(a.total, b.total), since }
}

/** The cost of the last 7 days, today included, and how many of them were tracked. */
export const weekCost = (c: Costs, today: string): { usd: number; days: number } => {
  const days = lastDays(today, 7).filter(d => !c.since || d >= c.since)
  return { usd: days.reduce((n, d) => n + (c.days[d] ?? 0), 0), days: Math.max(1, days.length) }
}

/** What a new cost reading adds: the growth since `seen`, or nothing when the session's figure went down (after /clear). */
export const costDelta = (usd: number, seen: number | null) => (seen === null ? usd : Math.max(0, usd - seen))

// ---------------------------------------------------------------- session log

export const LOG_MAX = 8

/** The log with `entry` added last, keeping the newest LOG_MAX lines. */
export const pushLog = (log: unknown, entry: LogEntry): LogEntry[] => [...(Array.isArray(log) ? (log as LogEntry[]) : []), entry].slice(-LOG_MAX)

/** `HH:MM` at `ms` in `timeZone`. */
export const hhmm = (ms: number, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

/** `Wed 11/18 15:24` at `ms` in `timeZone`, for the pane's header. */
export const headerDate = (ms: number, timeZone: string) => {
  const wall = wallClock(ms, timeZone)
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
    new Date(Date.UTC(Number(wall.key.slice(0, 4)), Number(wall.key.slice(5, 7)) - 1, Number(wall.key.slice(8, 10)))).getUTCDay()
  ]
  return `${wd} ${wall.key.slice(5, 7)}/${wall.key.slice(8, 10)} ${hhmm(ms, timeZone)}`
}

/** A tool's name as the log may show it: a built-in tool by name, any MCP tool as `MCP tool`. */
export const toolLabel = (tool: string) => (tool.startsWith('mcp__') ? 'MCP tool' : tool.replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'tool')

// ---------------------------------------------------------------- turn

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export const afterCall = (t: Turn, c: { hasFailed: boolean; isEdit: boolean }): Turn => ({
  ...t,
  edits: t.edits + (c.isEdit ? 1 : 0),
  errors: t.errors + (c.hasFailed ? 1 : 0),
  errorStreak: c.hasFailed ? t.errorStreak + 1 : 0,
})

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- engine version

/** Whether the engine's Text takes `mono` (2.1.299+). (From Flightdeck.) */
export const knowsMono = (v: { version?: string; base?: string } | null | undefined): boolean => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v?.base ?? v?.version ?? '')
  if (!m) return false
  const want = [2, 1, 299]
  for (let i = 0; i < 3; i += 1) {
    const part = Number(m[i + 1])
    if (part !== want[i]) return part > want[i]!
  }
  return true
}

export const faultKey = (surface: string, module: string) => `${surface}:${module.split(/[\\/]/).pop()}`

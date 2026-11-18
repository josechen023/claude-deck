// Deck: a read-only bookkeeping sidebar. A shiba, your daily jobs, task-list progress, usage and the
// current turn. Forked from Flightdeck by Stephen Casella (MIT).
//
// Observe only: every hook passes its event on unchanged, and what it notes is done after the event's
// own result is in hand. Nothing here spawns a process, makes a request or calls a model; the only
// thing kept past the session is `$.store`: per-day job status and the pet's completed count.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Daily, Flash, JobStatus, Life, LogEntry } from '../types'
import {
  DEFAULT_DAILY,
  DEFAULT_LIFE,
  DEFAULT_PROGRESS,
  DEFAULT_SPEND,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  EDIT_TOOLS,
  FACE,
  MOOD,
  afterCall,
  afterTaskCreate,
  afterTaskUpdate,
  afterTodoWrite,
  contextPct,
  faultKey,
  flashLeft,
  fmtDuration,
  fmtResetIn,
  gauge,
  gridRow,
  jobsIn,
  knowsMono,
  lastDays,
  levelOf,
  limitOf,
  mergeDaily,
  normalize,
  normalizeDaily,
  parseConfig,
  pendingToday,
  petStateOf,
  plural,
  progressOf,
  prune,
  recordJob,
  reminderFor,
  todayLine,
  wallClock,
  windowsOf,
} from './core'
import { DEFAULT_COSTS, addCost, costDelta, mergeCosts, normalizeCosts, weekCost } from './core'
import { addRequest, cacheHitPct, fmtTokens, fmtUsd, shortModel, usdPerHour } from './core'
import { CAT_FACE, CELL_W, KEEP_DAYS, LOG_MAX, headerDate, hhmm, pushLog, toolLabel, dayKeyOf, dayLabel, gridDaysFor, monthDay, paceOf, shiftDay, timePct, trackedSpan } from './core'
import type { Cell, Config, PetState } from './core'

const PANE = 'deck'
const TITLE = 'Deck'
const STORE_DAILY = 'daily'
const STORE_LIFE = 'life'

// Theme roles, so the pane follows the Claude Code theme (light, dark, colour-blind).
const C = {
  pet: 'claude',
  done: 'success',
  missed: 'error',
  pending: 'subtle',
  warn: 'warning',
  dim: 'inactive',
  text: 'text',
  // section borders and titles
  secDaily: 'suggestion',
  secProgress: 'remember',
  secUsage: 'planMode',
  secTurn: 'inactive',
  secLog: 'subtle',
  secModel: 'ide',
  cat: 'permission',
} as const

// ---------------------------------------------------------------- state

const daily = atom({ plugin: 'deck', key: 'daily' } as const, DEFAULT_DAILY)
const life = atom({ plugin: 'deck', key: 'life' } as const, DEFAULT_LIFE)
const progress = atom({ plugin: 'deck', key: 'progress' } as const, DEFAULT_PROGRESS)
const usage = atom({ plugin: 'deck', key: 'usage' } as const, DEFAULT_USAGE)
const turn = atom({ plugin: 'deck', key: 'turn' } as const, DEFAULT_TURN)
const flash = atom({ plugin: 'deck', key: 'flash' } as const, null)
const log = atom({ plugin: 'deck', key: 'log' } as const, [] as LogEntry[])
const spend = atom({ plugin: 'deck', key: 'spend' } as const, DEFAULT_SPEND)
const costs = atom({ plugin: 'deck', key: 'costs' } as const, DEFAULT_COSTS)
const costSeen = atom({ plugin: 'deck', key: 'costSeen' } as const, null as number | null)
const STORE_COSTS = 'costs'

/** A new reading of this session's cost: what grew since the last reading goes to today's day in the store. */
async function noteCost($: EngineInterface, cfg: Config, usd: number) {
  const seen = await read($, costSeen)
  const delta = costDelta(usd, seen)
  await update($, costSeen, () => usd)
  const fresh = normalizeCosts(await $.store.get(STORE_COSTS).catch(() => undefined))
  if (delta <= 0) {
    await update($, costs, c => mergeCosts(normalizeCosts(c), fresh))
    return
  }
  const today = wallClock(await $.clock.now(), cfg.timeZone).key
  // Read the store fresh: another session may have added its own cost since.
  const merged = addCost(mergeCosts(fresh, normalizeCosts(await read($, costs))), today, delta)
  await $.store.set(STORE_COSTS, merged)
  await update($, costs, () => merged)
}

/** Adds a line to the session log. Callers pass job names, tool names, statuses and counts only. */
async function note($: EngineInterface, kind: LogEntry['kind'], text: string) {
  const at = await $.clock.now()
  await update($, log, l => pushLog(l, { at, kind, text }))
}

async function storedDaily($: EngineInterface): Promise<Daily> {
  return normalizeDaily(await $.store.get(STORE_DAILY).catch(() => undefined))
}
async function storedLife($: EngineInterface): Promise<Life> {
  const v = normalize(DEFAULT_LIFE, await $.store.get(STORE_LIFE).catch(() => undefined))
  return { completed: Math.max(0, Math.floor(Number(v.completed) || 0)) }
}

/** The store as this session sees it, merged with what another session may have written since. */
async function loadHistory($: EngineInterface, cfg: Config) {
  const today = wallClock(await $.clock.now(), cfg.timeZone).key
  const d = prune(await storedDaily($), today)
  await update($, daily, x => prune(mergeDaily(normalizeDaily(x), d), today))
  const l = await storedLife($)
  await update($, life, x => ({ completed: Math.max(l.completed, normalize(DEFAULT_LIFE, x).completed) }))
}

async function noteJob($: EngineInterface, cfg: Config, job: string, status: JobStatus, day?: string) {
  const wall = wallClock(await $.clock.now(), cfg.timeZone)
  const today = day ?? wall.key
  // Read the store fresh: a second session may have recorded a job since this one loaded.
  const merged = recordJob(mergeDaily(await storedDaily($), normalizeDaily(await read($, daily))), today, job, status)
  await $.store.set(STORE_DAILY, merged)
  await update($, daily, () => merged)
  await note($, 'job', `${job} ${status === 'done' ? '✓ done' : '✗ failed'}${day && day !== wall.key ? ` (${day.slice(5).replace('-', '/')})` : ''}`)
}

async function noteCompleted($: EngineInterface, n: number) {
  if (n <= 0) return
  const l = await storedLife($)
  const completed = Math.max(l.completed, normalize(DEFAULT_LIFE, await read($, life)).completed) + n
  await $.store.set(STORE_LIFE, { completed })
  await update($, life, () => ({ completed }))
  const prog = progressOf(normalize(DEFAULT_PROGRESS, await read($, progress)))
  await note($, 'task', `${plural(n, 'task')} completed${prog ? ` · ${prog.done}/${prog.total}` : ''}`)
  await raise($, { kind: 'jump', at: await $.clock.now() })
}

/** A short pet reaction, redrawn away once it has run its time. */
async function raise($: EngineInterface, f: NonNullable<Flash>) {
  await update($, flash, () => f)
  const left = flashLeft(f, f.at)
  if (left !== null) $.clock.after(left + 50, () => $.ui.invalidate('ui.render'))
}

async function resetSession($: EngineInterface) {
  await update($, progress, () => DEFAULT_PROGRESS)
  await update($, turn, () => DEFAULT_TURN)
  await update($, flash, () => null)
  await update($, log, () => [])
}

function openPane($: EngineInterface, cfg: Config) {
  // columns apply when docked beside the fullscreen transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: cfg.paneColumns, rows: 3 })
}

type Ran = { deny?: string; isError?: boolean; result?: unknown }
type Call = { tool: string; agentId?: string } & Record<string, unknown>

/** What a finished tool call means for the deck. Reads the call's input and result, keeps counts only. */
async function observe($: EngineInterface, cfg: Config, e: Call, ran: Ran) {
  const didRun = ran.deny === undefined
  const isOk = didRun && ran.isError !== true

  if (e.tool === 'Bash' && didRun && typeof e.command === 'string') {
    // The command is matched here and dropped: only the job name and outcome are kept.
    for (const job of jobsIn(e.command, cfg.jobs)) await noteJob($, cfg, job, isOk ? 'done' : 'failed')
  }

  if (isOk && e.tool === 'TodoWrite') {
    let newlyDone = 0
    await update($, progress, p => {
      const x = afterTodoWrite(normalize(DEFAULT_PROGRESS, p), e.todos)
      newlyDone = x.newlyDone
      return x.progress
    })
    await noteCompleted($, newlyDone)
  } else if (isOk && e.tool === 'TaskCreate') {
    const id = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
    await update($, progress, p => afterTaskCreate(normalize(DEFAULT_PROGRESS, p), id))
  } else if (isOk && e.tool === 'TaskUpdate') {
    let newlyDone = 0
    await update($, progress, p => {
      const x = afterTaskUpdate(normalize(DEFAULT_PROGRESS, p), e.taskId, e.status)
      newlyDone = x.newlyDone
      return x.progress
    })
    await noteCompleted($, newlyDone)
  }

  // The turn panel counts the main loop's calls; a subagent's are its own.
  if (!e.agentId && didRun) {
    const hasFailed = ran.isError === true
    await update($, turn, t => afterCall(normalize(DEFAULT_TURN, t), { hasFailed, isEdit: !hasFailed && EDIT_TOOLS.has(e.tool) }))
    if (hasFailed) {
      await note($, 'error', `${toolLabel(e.tool)} call failed`)
      await raise($, { kind: 'error', at: await $.clock.now() })
    }
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const JOBS = cfg.jobs.map(j => j.name)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deck',
      description: 'Deck sidebar: open, close, reset session counters, or mark a daily job done',
      argumentHint: `[open|close|reset|done ${JOBS.length > 0 ? JOBS.join('|') : '<job>'} [YYYYMMDD]]`,
    })
    await loadHistory($, cfg)
    const u = await $.session.usage().catch(() => null)
    if (u) await update($, usage, () => ({ pct: contextPct(u.context), limits: u.rateLimits.map(limitOf) }))
    const storedCosts = normalizeCosts(await $.store.get(STORE_COSTS).catch(() => undefined))
    await update($, costs, c => mergeCosts(normalizeCosts(c), storedCosts))
    // A session's first start counts from its cost now (a resumed session's earlier cost was counted
    // then); a reload keeps the baseline it had.
    if ((await read($, costSeen)) === null) await update($, costSeen, () => u?.cost?.usd ?? 0)
    const model = await $.session.model().catch(() => null)
    await update($, spend, s => {
      const x = normalize(DEFAULT_SPEND, s)
      return {
        ...x,
        model: x.model ?? model,
        startedAt: u?.startedAt ?? x.startedAt,
        usd: u?.cost ? u.cost.usd : x.usd,
        hasUnknownPrice: u?.cost?.hasUnknownPrice === true || x.hasUnknownPrice,
      }
    })
    // The grid's day and the reminder hour move with the clock, not with events: look again each minute.
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    if ((await read($, log)).length === 0) await note($, 'session', 'session started')
    if (cfg.openOnStart) void openPane($, cfg).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetSession($)
    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    const [verb = 'open', arg = '', when = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Deck closed.' }
    }
    if (verb === 'reset') {
      await resetSession($)
      return { text: 'Deck session counters reset. Daily history and the pet are kept.' }
    }
    if (verb === 'done') {
      if (JOBS.length === 0) return { text: 'No daily jobs are set: add them under the deck plugin\'s `jobs` option, as `name=pattern; name=pattern`.' }
      const job = JOBS.find(j => j === arg)
      const usage = `Usage: /deck done ${JOBS.join('|')} [YYYYMMDD or YYYY-MM-DD, within the last ${KEEP_DAYS} days]`
      if (!job) return { text: usage }
      const today = wallClock(await $.clock.now(), cfg.timeZone).key
      const day = when === '' ? today : dayKeyOf(when)
      if (!day || day > today || day < shiftDay(today, -(KEEP_DAYS - 1))) return { text: usage }
      await noteJob($, cfg, job, 'done', day)
      return { text: `Marked ${job} done for ${day}. ${todayLine(normalizeDaily(await read($, daily)), today, JOBS)}.` }
    }
    if (verb !== 'open' && verb !== '') return { text: 'Usage: /deck [open|close|reset|done <job>]' }
    const opened = await openPane($, cfg)
    return { text: opened.isPlaced ? 'Deck opened.' : `Deck is not shown yet: ${opened.reason}` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, turn, () => ({ ...DEFAULT_TURN, isRunning: true, startedAt: now }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      let t1 = DEFAULT_TURN
      await update($, turn, t => (t1 = { ...normalize(DEFAULT_TURN, t), isRunning: false, endedAt: now }))
      if (t1.startedAt > 0) {
        const errs = t1.errors > 0 ? ` · ${plural(t1.errors, 'error')}` : ''
        await note($, 'turn', `turn ${fmtDuration(now - t1.startedAt)} · ${plural(t1.edits, 'edit')}${errs}`)
      }
    }
    return done
  })

  // Every model request: its tokens count toward the session (subagents' too); the main loop's names the model.
  on('turn.step', async function* ($, e, next) {
    // Forward every chunk untouched; only the finished request's usage is read.
    const r = yield* next(e)
    const u = r.usage
    void update($, spend, s => {
      let x = normalize(DEFAULT_SPEND, s)
      if (u) x = addRequest(x, u)
      if (e.agentId === undefined) x = { ...x, model: u?.model ?? e.model ?? x.model, effort: e.effort === undefined ? x.effort : String(e.effort) }
      return x
    }).catch(() => undefined)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const done = await next(e)
    await update($, usage, () => ({ pct: contextPct(e.context), limits: e.rateLimits.map(limitOf) }))
    const cost = e.cost
    if (cost) {
      await update($, spend, s => ({ ...normalize(DEFAULT_SPEND, s), usd: cost.usd, hasUnknownPrice: cost.hasUnknownPrice === true }))
      await noteCost($, cfg, cost.usd)
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    // Noted after the result is in hand and not awaited: the call's answer goes back untouched, at once.
    void observe($, cfg, e as unknown as Call, ran as Ran).catch(() => undefined)
    return ran
  })

  // ---------------------------------------------------------------- drawing

  // A surface module that faults is drawn as plain text there from then on (Flightdeck's pattern).
  const faulted = new Set<string>()
  on('ui.fault', async ($, e, next) => {
    const key = faultKey(e.surface, e.module)
    if (e.requestId === PANE && !faulted.has(key)) {
      faulted.add(key)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  let monoRead: Promise<boolean> | null = null

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const hasClient = 'Client' in els
    const [d0, l, p, u, t, f, lg, sp0, cs0, now, mono] = await Promise.all([
      read($, daily),
      read($, life),
      read($, progress),
      read($, usage),
      read($, turn),
      read($, flash),
      read($, log),
      read($, spend),
      read($, costs),
      $.clock.now(),
      (monoRead ??= $.session
        .version()
        .then(knowsMono)
        .catch(() => false)),
    ])
    const d = normalizeDaily(d0)
    const tn = normalize(DEFAULT_TURN, t)
    const us = normalize(DEFAULT_USAGE, u)
    const wall = wallClock(now, cfg.timeZone)
    const reminder = reminderFor(d, wall, cfg.reminderHour, JOBS)
    const pending = pendingToday(d, wall.key, JOBS)
    const state: PetState = petStateOf({ now, turn: tn, flash: f ?? null, usage: us, allDone: JOBS.length > 0 && pending.length === 0, reminder })
    const prog = progressOf(normalize(DEFAULT_PROGRESS, p))
    const lvl = levelOf(normalize(DEFAULT_LIFE, l).completed)
    const W = Math.max(24, e.props.bodyColumns)
    const isDock = e.props.placement === 'dock'

    const pct = (n: number) => `${Math.round(n)}%`
    const ctxText = us.pct !== null ? `ctx ${pct(us.pct)}` : 'ctx —'
    const windows = windowsOf(us.limits).map(w => ({ label: w.label, l: w.limit }))
    const face = FACE[state]

    // ---- inline: a compact summary above the prompt, three rows at most.
    if (!isDock) {
      const parts = [
        prog ? `tasks ${prog.done}/${prog.total}` : 'no task list',
        ctxText,
        ...windows.map(w => `${w.label} ${pct(w.l.pct)}`),
      ]
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text color={C.pet}>({face}) </Text>
            <Text bold>{cfg.petName}</Text>
            <Text dimColor>{` Lv${lvl.level} · ${parts.join(' · ')}`}</Text>
          </Text>
          <Text wrap="truncate" color={reminder.length > 0 ? C.warn : C.dim} bold={reminder.length > 0}>
            {reminder.length > 0 ? `woof! ${reminder.join(', ')} pending` : todayLine(d, wall.key, JOBS)}
          </Text>
        </Box>
      )
    }

    // ---- docked beside the fullscreen transcript: each section in its own rounded box (Flightdeck's look)
    const inner = W - 4 // border and paddingX on each side
    const section = (key: string, title: string, color: string, right: string | null, body: RenderChildren) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={W}>
        <Box justifyContent="space-between">
          <Text color={color} bold wrap="truncate">
            {title}
          </Text>
          {right ? <Text dimColor wrap="truncate">{right}</Text> : null}
        </Box>
        {body}
      </Box>
    )
    const bar = (value: number, width: number, hot = false) => {
      const g = gauge(value, width)
      return (
        <Text>
          <Text color={hot ? C.warn : C.pet}>{g.on}</Text>
          <Text color={C.pending}>{g.off}</Text>
        </Text>
      )
    }
    const gaugeW = Math.max(6, Math.min(16, inner - 18))
    /** A gauge with ┃ where the window's time has got to, so usage reads against time gone. */
    const pacedBar = (value: number, time: number | null, width: number, hot: boolean) => {
      const g = gauge(value, width)
      const full = g.on.length
      const at = time === null ? -1 : Math.min(width - 1, Math.floor((time / 100) * width))
      return (
        <Text>
          {Array.from({ length: width }, (_, i) =>
            i === at ? (
              <Text color={C.text} bold>
                ┃
              </Text>
            ) : (
              <Text color={i < full ? (hot ? C.warn : C.pet) : C.pending}>{i < full ? '▰' : '▱'}</Text>
            ),
          )}
        </Text>
      )
    }

    const animal = (kind: 'shiba' | 'cat', color: string) =>
      hasClient && !faulted.has(faultKey(e.surface, 'pet.tsx')) ? (
        <els.Client
          key={kind}
          module="./pet.tsx"
          width={15}
          height={4}
          props={{ state, motion: cfg.motion, color, tongue: C.missed, mark: C.warn, mono, kind }}
        />
      ) : (
        <Text color={color}>{`( ${kind === 'cat' ? CAT_FACE[state] : face} )`}</Text>
      )
    // The cat sits beside the shiba where the box has room for both.
    const hasCat = inner >= 32
    const pet = (
      <Box columnGap={2}>
        {animal('shiba', C.pet)}
        {hasCat ? animal('cat', C.cat) : null}
      </Box>
    )

    const logColor = (x: LogEntry) =>
      x.kind === 'error' || x.text.includes('✗') ? C.missed : x.kind === 'job' ? C.done : x.kind === 'task' ? C.pet : C.text
    const cellColor = (c: Cell) => (c === 'done' ? C.done : c === 'missed' ? C.missed : C.pending)
    const nameW = Math.max(5, ...JOBS.map(j => j.length)) + 1
    // Only days since tracking began: earlier days have no data to show.
    const n = Math.min(gridDaysFor(inner, nameW), trackedSpan(d, wall.key))
    const days = lastDays(wall.key, n)
    const labels = days.map(dayLabel)
    const pad = ' '.repeat(nameW)
    const labelRow = (pick: (x: ReturnType<typeof dayLabel>) => string) => (
      <Text wrap="truncate">
        <Text>{pad}</Text>
        {labels.map((x, i) => {
          const isToday = i === labels.length - 1
          return (
            <Text color={isToday ? C.pet : C.dim} bold={isToday} dimColor={!isToday && x.isWeekend}>
              {pick(x).padEnd(CELL_W)}
            </Text>
          )
        })}
      </Text>
    )

    const doneToday = JOBS.length - pending.length
    const sp = normalize(DEFAULT_SPEND, sp0)
    const hit = cacheHitPct(sp)
    const perHour = usdPerHour(sp.usd, sp.startedAt, now)
    const cs = normalizeCosts(cs0)
    const week = weekCost(cs, wall.key)
    const header = (
      <Box key="header" flexDirection="column" alignItems="center" width={W} marginBottom={1}>
        <Text wrap="truncate">
          <Text color={C.pet} bold>
            {W >= 30 ? '━━  D E C K  ━━' : 'DECK'}
          </Text>
        </Text>
        <Text wrap="truncate">
          <Text dimColor>{`${headerDate(now, cfg.timeZone)} · `}</Text>
          <Text color={tn.isRunning ? C.pet : C.dim} bold={tn.isRunning}>
            {tn.isRunning ? 'WORKING' : 'IDLE'}
          </Text>
          {JOBS.length > 0 ? <Text dimColor>{' · '}</Text> : null}
          {JOBS.length > 0 ? (
            <Text color={doneToday === JOBS.length ? C.done : reminder.length > 0 ? C.warn : C.text} bold>
              {`daily ${doneToday}/${JOBS.length}`}
            </Text>
          ) : null}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" width={W}>
        {header}
        {section(
          'pet',
          hasCat ? `${cfg.petName} & ${cfg.catName}` : cfg.petName,
          C.pet,
          `Lv ${lvl.level}`,
          <Box flexDirection="column">
            {pet}
            <Text wrap="truncate">
              {bar((lvl.into * 100) / lvl.need, 5)}
              <Text dimColor>{`  ${MOOD[state]}`}</Text>
            </Text>
            {reminder.length > 0 ? (
              <Text color={C.warn} bold wrap="truncate">
                {`woof! ${reminder.join(', ')} ${reminder.length === 1 ? 'is' : 'are'} still pending`}
              </Text>
            ) : null}
          </Box>,
        )}

        {section(
          'daily',
          'DAILY',
          C.secDaily,
          n === 1 ? `today ${monthDay(wall.key)}` : `${monthDay(days[0]!)} → ${monthDay(wall.key)}`,
          JOBS.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>no daily jobs set</Text>
              <Text dimColor wrap="truncate">{'add them under the `jobs` option'}</Text>
            </Box>
          ) : (
          <Box flexDirection="column">
            {JOBS.map(job => {
              const isHot = reminder.includes(job)
              return (
                <Text wrap="truncate">
                  <Text color={isHot ? C.warn : C.text} bold={isHot}>
                    {job.padEnd(nameW)}
                  </Text>
                  {gridRow(d, job, wall.key, n).map(c => (
                    <Text color={cellColor(c)}>{'■'.padEnd(CELL_W)}</Text>
                  ))}
                </Text>
              )
            })}
            {labelRow(x => x.dom)}
            {labelRow(x => x.wd)}
            <Text color={pending.length === 0 ? C.done : reminder.length > 0 ? C.warn : C.text} wrap="truncate">
              {todayLine(d, wall.key, JOBS)}
            </Text>
          </Box>
          ),
        )}

        {section(
          'progress',
          'PROGRESS',
          C.secProgress,
          prog ? `${prog.done}/${prog.total}` : null,
          prog ? (
            <Text wrap="truncate">
              {bar((prog.done * 100) / prog.total, gaugeW)}
              <Text bold>{`  ${Math.round((prog.done * 100) / prog.total)}%`}</Text>
            </Text>
          ) : (
            <Text dimColor>no task list</Text>
          ),
        )}

        {section(
          'usage',
          'USAGE',
          C.secUsage,
          null,
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text dimColor>{'ctx'.padEnd(6)}</Text>
              {us.pct !== null ? bar(us.pct, gaugeW, us.pct > 85) : <Text dimColor>—</Text>}
              {us.pct !== null ? <Text>{` ${pct(us.pct)}`}</Text> : null}
            </Text>
            {windows.length === 0 ? <Text dimColor>no rate-limit windows reported</Text> : null}
            {windows.map(w => {
              const resetIn = fmtResetIn(w.l.resetsAt, now)
              const time = timePct(w.label, w.l.resetsAt, now)
              const pace = time === null ? null : paceOf(w.l.pct, time)
              return (
                <Box flexDirection="column">
                  <Text wrap="truncate">
                    <Text dimColor>{w.label.padEnd(6)}</Text>
                    {pacedBar(w.l.pct, time, gaugeW, w.l.pct > 85)}
                    <Text>{` ${pct(w.l.pct)}`}</Text>
                    <Text dimColor>{resetIn ? ` ↻${resetIn}` : ''}</Text>
                  </Text>
                  {time !== null && pace ? (
                    <Text wrap="truncate">
                      <Text dimColor>{`${''.padEnd(6)}┃ time ${pct(time)} · `}</Text>
                      <Text color={pace.kind === 'under' ? C.done : pace.kind === 'over' ? C.warn : C.dim}>
                        {pace.kind === 'under' ? `${pace.gap}% to spare` : pace.kind === 'over' ? `${pace.gap}% over pace` : 'on pace'}
                      </Text>
                    </Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>,
        )}

        {section(
          'model',
          'MODEL',
          C.secModel,
          `${shortModel(sp.model)}${sp.effort ? ` · ${sp.effort}` : ''}`,
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text dimColor>{'tokens'.padEnd(7)}</Text>
              <Text>{`out ${fmtTokens(sp.output)}`}</Text>
              <Text dimColor>{` · in ${fmtTokens(sp.input + sp.cacheRead + sp.cacheWrite)} · ${plural(sp.requests, 'req')}`}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>{'cache'.padEnd(7)}</Text>
              {hit !== null ? bar(hit, Math.max(6, gaugeW - 4), false) : <Text dimColor>—</Text>}
              <Text>{hit !== null ? ` ${pct(hit)} hit` : ''}</Text>
              <Text dimColor>{` · read ${fmtTokens(sp.cacheRead)}`}</Text>
            </Text>
            <Text dimColor wrap="truncate">{sp.hasUnknownPrice ? 'est. cost*' : 'est. cost'}</Text>
            <Text wrap="truncate">
              <Text dimColor>{'  session'.padEnd(10)}</Text>
              <Text bold>{sp.usd !== null ? fmtUsd(sp.usd) : '—'}</Text>
              <Text dimColor>{perHour !== null ? ` · ${fmtUsd(perHour)}/h` : ''}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>{'  7 days'.padEnd(10)}</Text>
              <Text bold>{fmtUsd(week.usd)}</Text>
              <Text dimColor>{` · ${fmtUsd(week.usd / week.days)}/day`}</Text>
            </Text>
            <Text wrap="truncate">
              <Text dimColor>{'  total'.padEnd(10)}</Text>
              <Text bold>{fmtUsd(cs.total)}</Text>
              <Text dimColor>{cs.since ? ` · since ${monthDay(cs.since)}` : ' · from now on'}</Text>
            </Text>
          </Box>,
        )}

        {section(
          'turn',
          'TURN',
          tn.isRunning ? C.pet : C.secTurn,
          tn.startedAt <= 0 ? null : tn.isRunning ? '● running' : '○ idle',
          tn.startedAt <= 0 ? (
            <Text dimColor>no turn yet</Text>
          ) : (
            <Box overflow="hidden">
              <Box flexShrink={0}>
                {tn.isRunning && hasClient && !faulted.has(faultKey(e.surface, 'elapsed.tsx')) ? (
                  <els.Client key="elapsed" module="./elapsed.tsx" props={{ since: tn.startedAt, now, endAt: null, color: C.text }} />
                ) : (
                  <Text>{fmtDuration((tn.endedAt ?? now) - tn.startedAt)}</Text>
                )}
              </Box>
              <Text wrap="truncate">
                <Text dimColor>{` · ${plural(tn.edits, 'edit')} · `}</Text>
                <Text color={tn.errors > 0 ? C.missed : C.dim}>{plural(tn.errors, 'error')}</Text>
              </Text>
            </Box>
          ),
        )}

        {section(
          'log',
          'SESSION LOG',
          C.secLog,
          lg.length > 0 ? `last ${Math.min(lg.length, LOG_MAX)}` : null,
          lg.length === 0 ? (
            <Text dimColor>nothing yet</Text>
          ) : (
            <Box flexDirection="column">
              {lg.map(x => (
                <Text wrap="truncate">
                  <Text dimColor>{`${hhmm(x.at, cfg.timeZone)}  `}</Text>
                  <Text color={logColor(x)}>{x.text}</Text>
                </Text>
              ))}
            </Box>
          ),
        )}
      </Box>
    )
  })
}

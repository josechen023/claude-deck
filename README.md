# Deck

A read-only sidebar mod for [Claude Code](https://claude.com/claude-code): a shiba and a cat whose moods
follow your session, a grid of the daily jobs you run with Claude, task-list progress, context and
rate-limit usage, model tokens with an estimated cost, and the current turn — all kept beside the
transcript while you work.

```
        ━━  D E C K  ━━
   Wed 11/18 15:24 · WORKING · daily 2/3
╭────────────────────────────────────────────╮
│ SHIBA & NEKO                          Lv 3 │
│           z            z                   │
│   /^-^\___       /\_/\                     │
│  ( -ᴥ-     )@   ( -.- )___                 │
│ ▰▰▱▱▱  asleep                              │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ DAILY                        11/12 → 11/18 │
│ backup ■  ■  ■  ■  ■  ■  ■                 │
│ report ■  ■  ■  ■  ■  ■  ■                 │
│ today 1/2 · report pending                 │
╰────────────────────────────────────────────╯
╭────────────────────────────────────────────╮
│ MODEL                          opus · high │
│ tokens out 18k · in 1.2M · 42 reqs         │
│ cache  ▰▰▰▰▰▰▰▰▰▱▱▱ 94% hit · read 1.1M    │
│ est. cost                                  │
│   session $1.84 · $0.92/h                  │
│   7 days  $9.10 · $1.30/day                │
╰────────────────────────────────────────────╯
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install deck --marketplace joe20201830/claude-deck
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install deck --marketplace joe20201830/claude-deck
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then
**Plugins**, **Add marketplace** with `joe20201830/claude-deck`, then **Add plugin**. A mod installed from a
terminal at the user scope also loads in the desktop app's local Code sessions.

Requires Claude Code 2.1.289 or later. The pane docks beside the transcript in fullscreen mode
(`/config` → fullscreen); otherwise it sits above the prompt as a two-row summary.

## What it shows

1. **Pet**: an animated ASCII shiba (and a cat, when the pane is wide enough). It sleeps when idle,
   wags while Claude works, jumps when a task-list item is completed, tilts its head after an error,
   is happy once all daily jobs are done, looks full past 85% context, lies down past 85% of a rate
   limit, and barks about pending jobs from the reminder hour. It levels up with every task-list item
   completed, across sessions.
2. **DAILY**: your daily jobs as a grid of days, oldest left and today right. Green: the job ran
   successfully that day. Red: not run, or it failed. Gray: today, still pending.
3. **PROGRESS**: completed / total items on Claude's own task list.
4. **USAGE**: context fill, and the 5-hour and weekly rate-limit windows with time to reset. A ┃ marks
   how much of each window's time has gone, so you can see whether you are under, on or over pace.
5. **MODEL**: the model and effort; the session's tokens (output, all input, requests, subagents
   included); the prompt-cache hit rate; and the estimated cost for this session, the last 7 days and
   the total since tracking began.
6. **TURN**: whether a turn is running, how long it has taken, its edits and errors.
7. **SESSION LOG**: the session's last 8 events: jobs done or failed, task items completed, finished
   turns, and failed tool calls by tool name.

### The cache hit rate

Every request to the model re-sends the whole conversation so far. The part already sent before is
served from Anthropic's prompt cache, which is faster and billed at a fraction of the input price.
The hit rate is cache reads ÷ (fresh input + cache reads + cache writes), so after the first few
requests of a session it normally sits above 90%. High is good.

## Daily jobs

Deck ships with no jobs. Add your own under the `jobs` option as `name=pattern` entries separated by
`;` (up to 6):

```
backup=scripts/backup\.sh; report=make report; sync=rsync .*backup
```

A job counts as done for the day when Claude runs a Bash command matching its pattern (a
case-insensitive regular expression) and the command succeeds. A matching command that fails marks
the day red, unless the job succeeds later that day. For a job you ran outside Claude Code, use
`/deck done <job>`, or `/deck done <job> YYYYMMDD` for an earlier day in the last 30.

Days start at midnight in the `timeZone` option (default `UTC`).

## Options

Set these in the plugin config menu, or in `~/.claude/settings.json` under
`pluginConfigs.deck.options`:

| Option | Default | |
| --- | --- | --- |
| `jobs` | *(none)* | Daily jobs, `name=pattern; name=pattern` |
| `timeZone` | `UTC` | IANA time zone whose midnight starts a new day |
| `reminderHour` | `16` | Hour (0–23) from which the shiba barks about pending jobs; `-1` turns it off |
| `petName` / `catName` | `SHIBA` / `NEKO` | Names shown in the pet section |
| `motion` | `on` | `off` keeps the pets still |
| `paneColumns` | `50` | Pane width when docked (32 or more) |
| `openOnStart` | `true` | Open the pane when a session starts |

## Commands

- `/deck` — open the pane
- `/deck close` — close it
- `/deck reset` — reset this session's counters (progress, turn, log); history and the pet are kept
- `/deck done <job> [YYYYMMDD]` — mark a job done for today, or a day in the last 30

## What is kept, and privacy

Deck only observes: every hook passes its event on unchanged. It makes no network requests, starts no
processes and calls no model. It never shows file paths, commands, tool inputs, prompts or task text —
only numbers, job names, statuses and built-in tool names (any MCP tool shows as `MCP tool`).

Kept across sessions, in the plugin's own local store on your machine: per-day job status (30 days),
the pet's completed count, and estimated cost (per day for 30 days, plus a running total). Session
counters — tokens, cache hit, the session's cost, progress, turn and log — start fresh in each session.
Cost history is per machine: two computers keep separate totals.

Costs are estimates, as `/cost` reports them, not your bill.

## Developing

```
git clone https://github.com/joe20201830/claude-deck
claude --plugin-dir ./claude-deck      # load it for one session
claude plugin test ./claude-deck       # run the tests
claude plugin validate ./claude-deck
```

## Credits

Deck is a fork of [Flightdeck](https://github.com/scasella/claude-flightdeck) by
[Stephen Casella](https://github.com/scasella), used under the MIT License (see `LICENSE`). The pane
structure, usage and rate-limit handling and the frame-clock animation come from Flightdeck. The pets,
the daily grid, progress and cost tracking are new.

## License

MIT — see [LICENSE](LICENSE).

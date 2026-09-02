# Change Log

All notable changes to the "token-watch" extension will be documented in this file.

## [Unreleased]

### Added

- `tokenWatch.retention.rawRecordDays` deletes per-turn detail older than the
  given number of days, in whole days. Daily and per-session totals are kept for
  every day regardless, so the dashboard history stays complete; a pruned day
  gives up its hourly drill-down, its tool-call detail, and the ability to
  reprice it. Default 0, which keeps everything and lets the database grow
  without limit — measured at roughly 10 MB a day under heavy use. On a real
  122 MB database a 14-day window removed 51,483 turns and 12,354 tool events
  and left the file 31% smaller, with every day's tokens and cost unchanged.
  "Token Watch: Show Diagnostics" reports which days still have per-turn detail.

### Changed

- The usage card lists limit resets behind "show more" instead of in the card.
  The list is reference material — which reset, of what kind, expiring when — and
  it pushed the numbers people open the card for further down the more resets
  they had. What stays is the count and one date: the soonest expiry, which is
  the deadline. The order a provider sends resets in is not the order they run
  out, so that date is chosen rather than taken from the front of the list.
- The expander now opens for an account whose only extra detail is its resets,
  which previously had nowhere to show them.
- Two indexes on `usage_record` are dropped on first open: `(source, session_id)`
  is a leading prefix of `(source, session_id, model)`, and `(day_local)` a
  prefix of `(day_local, source, variant_id, workspace)`, so SQLite already
  answered those lookups from the wider index by the same access path. They cost
  10.9 MB on a 122 MB database and bought nothing. Verified against real data:
  every dashboard result byte-identical across all fifteen tab and source
  combinations, and both lookups still plan as SEARCH, not SCAN.
- That drop is deliberately **not** a schema migration. No code names an index —
  SQLite chooses them — so a database without them is structurally unchanged and
  every build reads it the same way. It is applied as idempotent maintenance on
  every open instead.
- Dedup keys are stored compactly: a 16-character digest in place of the
  seventy-odd bytes of `source:session:file scope:request:offset` that used to
  sit in the primary key, in every tool event that points back at it, and in
  every cursor's record list. Nothing ever read inside those keys — the column
  is a primary key, joined for equality and nothing else — and on a real 122 MB
  database the structure cost 32 MB. In memory keys stay readable, because the
  ingest path still splits them to recognise the shape older releases wrote;
  hashing happens at the boundary where they are stored.
- Database schema 9, and this one does lock older builds out. A build from
  before the change computes the readable key, fails to find the compact row it
  belongs to, and inserts a second copy of any turn it re-reads instead of
  replacing it — double counting the tokens. Refusing at its own version check
  is the only lever available over code that is already shipped, so a window
  still running one must be reloaded after upgrading. Measured on a real 122 MB
  database, the migration takes 8 s of a 60 s startup budget, runs once, and
  leaves every dashboard result byte-identical across all fifteen tab and source
  combinations.
- An upgrade rewrites the database file once rather than once per step. Both the
  key migration and the index drop leave free pages that only a full rewrite
  gives back, and doing that rewrite twice took 8.1 s on a 122 MB database where
  one takes 4.4 s.
- Between the index drop and the compact keys, a 122 MB database becomes 69 MB
  on first open — 43% smaller — with no setting to change. With retention at 14
  days on top it becomes 47 MB.
- The database is compacted after that drop, after a retention pass, and after a
  reset. Dropped indexes and deleted rows leave free pages that SQLite reuses but
  never returns, and this store rewrites the whole file on every flush — so
  without compacting, freeing 10.9 MB of index changed the file size by exactly
  zero, and "Reset Database" left a 70 MB empty file that cost 70 MB on every
  flush thereafter. A reset now leaves 0.1 MB.
- A database whose old rows have been pruned is marked as schema 10. It is
  structurally identical to 9; the number exists only to stop a build that
  predates retention from opening it. Those builds compare every raw row against
  every aggregate, conclude a pruned database is corrupt, and rebuild the
  aggregates from rows that no longer exist — deleting the history retention was
  meant to preserve. A database only reaches 10 if the user turns retention on,
  and a reset puts it back to 9.

### Fixed

- Showing the panel again no longer forces both providers past their own
  spacing. Becoming visible refreshed Codex and Claude with `force`, so toggling
  the sidebar could put several calls through to Claude, which tolerates the
  least polling. The first time round nothing is cached and both still fetch;
  after that, reopening respects each provider's floor.
- The status bar tooltip words limit resets the same way the usage card does,
  rather than describing the same thing two ways.
- **Quota figures stopped refreshing after the first load.** A provider cache
  reports `retryAtUtc` for two reasons — a cooldown lifting after a refusal, and
  a good response going stale — but only the first carried `retryPending`, and
  only that one was scheduled. A healthy provider was fetched once and then left
  alone, so the numbers froze until someone pressed refresh or reopened the
  panel.
- The two providers are polled at their own cadence instead of a shared figure.
  One five-minute interval covered both, which was wrong in both directions:
  Codex figures went stale for five minutes when its own client refreshes every
  sixty seconds (openai/codex#10869), while Claude was polled faster than it
  tolerates. Codex is now 60-75s and Claude 180-210s, the interval community
  tools settled on for an endpoint that sends no Retry-After
  (anthropics/claude-code#31637).
- A refused request backs off 3, 6, 12 then 15 minutes instead of jumping
  straight to 15. Claude sends no Retry-After, so the wait is a guess; starting
  at the maximum meant one transient refusal cost a quarter of an hour of stale
  figures. A successful call clears the count.
- **Codex token counts were 39% too high.** Codex reports a cumulative total per
  rollout file, and the parser tracked the baseline for that total against the
  session id. Resuming a session writes its earlier turns again under the old id
  and then continues under a new one from the same number, so the first line
  after the switch looked like a single turn that had consumed the entire
  history. Measured against one real set of logs: 10,349,317,694 tokens too
  many, on 27 billion. The baseline now follows the file, which is what the
  counter actually belongs to.
- A counter that restarts mid-file — a new conversation in the same rollout — is
  now counted as a fresh series rather than dropped. Those tokens were consumed;
  discarding the line, as this used to, lost them.
- A single component going backwards can no longer inflate a turn. Clamping the
  input and output deltas separately reported more than the total Codex gives,
  which is the figure to trust; the total is now held fixed and the difference
  attributed to whichever side rose.
- The five disjoint token buckets add up to the turn again. Cached sits inside
  input and reasoning inside output, and the logs occasionally break that;
  clamping only the subtraction while keeping the whole cached figure made the
  buckets exceed the turn by 1,082,736 tokens across 45 turns in one real set of
  logs. The contained bucket is capped instead.
- Existing databases correct themselves. The logs do not change when a parser is
  fixed, so nothing would prompt a re-read; the Codex parse revision is bumped,
  which makes every cursor written by the old one read its file again from the
  start and replace what it stored. No rescan to remember, and no stale 39%.
- A database upgraded from schema 6 is re-read too. That migration stamped each
  cursor with the revision current at the time of the upgrade rather than the one
  that produced it, which would have asserted the old counts were already right
  and kept them for good.
- Verified end to end: a second implementation, written from the log formats
  rather than from this code, now agrees to the token with what ingestion
  stores — 27,089,591,540 Codex and 5,192,496,865 Claude across 216 real log
  files, zero difference on either.
- Audited end to end against 1.7 GB of real logs, and the checks kept as tests:
  reading a log in pieces now provably totals the same as reading it whole (the
  path a growing file actually takes); every stored row satisfies nine
  invariants, including that its five token buckets sum to its total and that
  its local day follows from its timestamp; and usage_record, daily_aggregate
  and session_aggregate all report the same 32,314,131,109 tokens.
- The panel stops waiting on work it does not need to see. Rebuilding every
  aggregate — about 1.5 seconds on a large database — used to happen before the
  worker reported ready, so the first launch after an upgrade sat on a spinner
  through it. The numbers already on disk are good enough to draw, so the repair
  now runs behind the panel and asks it to refetch when it lands. Time to the
  first Today on a real 122 MB database: 5.7 s to 4.1 s on the launch that also
  migrates, and about 0.1 s on every launch after.
- **The worker held every query until the scan finished.** `case "query"` pushed
  the request onto a queue whenever a scan was running and drained it at the end,
  so a first pass over a large log set — minutes — meant the panel asked, waited,
  and got `Timed out waiting for the worker (query)` after thirty seconds, twice
  over for the status bar. Queries are answered during a scan now: sql.js is
  synchronous and every commit is a transaction, so a query between commits sees
  a consistent database, just an earlier one than the scan will end with. Measured
  on 216 real logs: 35 queries asked mid-scan, median 18 ms, worst 29 ms.
- The worker records what it spent its time on and reports it under Timing in
  "Token Watch: Show Diagnostics" — including the longest it went without being
  able to answer anything, which is what a stuck panel actually is. Benchmarks
  written during development kept missing this class of problem because they call
  the code directly instead of going through the message handler; this measures
  the machine it runs on. On a 28.9 s scan of 216 real logs the worst such block
  was 2.6 s.
- The panel no longer waits out the whole first scan before showing anything.
  Three separate things kept it on a spinner: a query sent before the worker had
  finished spawning was rejected outright and never retried, so the numbers only
  appeared when the scan ended and pushed a refresh; nothing asked again while a
  scan was running, even though rows land within the first second of one; and a
  result that arrived empty counted as data, hiding the scan progress behind an
  empty dashboard. A request that arrives early now waits for the worker, the
  panel re-asks every 1.5 s while it still has nothing to draw, and the scan
  progress stays up until there are actually rows.
- The periods you are not looking at are fetched behind the one you are. The
  first visit to a tab still waited on a query; the whole set costs the worker
  around 130 ms and is pulled in when the browser is idle, so every switch is
  immediate, not just the second one.
- The dashboard reads five to seven times faster. Both tool queries joined
  `tool_event` to `usage_record` purely to filter by day and source, which
  `tool_event` already carries and is indexed on; between them they were 87% of
  the time a dashboard query spent reading. On a real database one query went
  from 176 ms to 36 ms, and Today from 65 ms to 26 ms. The join is still used
  when a filter needs a column only the record has.
- Long log lines no longer drop token counts. A line over the ingestion size
  limit was skipped unread on length alone, but length says nothing about what
  a line contains: an assistant turn that writes a large file is one very long
  line that still carries `message.usage`, and a Codex `token_count` line can be
  padded well past a megabyte. Those tokens were silently missing from every
  total. Oversized lines are now scanned for token data and parsed anyway when
  they carry it, up to an 8 MB ceiling. Measured against real logs afterwards:
  the largest usage-bearing line across 180,744 of them is 88 KB, so the ceiling
  has 93x headroom.
- The "skipped N oversized lines" warning is gone. Long lines that carry no token
  counts change no number on screen, so announcing them only made totals that
  were already complete look suspect. The panel now reports missing data and
  nothing else; the counts are still in "Token Watch: Show Diagnostics", which
  states plainly whether any tokens are missing from the totals.
- A log line still being written is no longer counted as one that could not be
  parsed. Every live session ends mid-line, and that line is deliberately left
  for the next scan to read whole — but it was also being added to a counter that
  only ever accumulates, so an active session permanently accused itself of
  dropping data it had not dropped.
- A line that genuinely could not be parsed now reads as what it is. Only lines
  already matching a usage marker reach the parser, so a failure there means
  countable data was lost, not a cosmetic gap.
- A full rescan now clears the data-loss counters along with the others. They
  survived the rescan that fixed them, leaving a warning on screen the user had
  already acted on.
- Models with no price rate no longer raise a warning in the panel: an unpriced
  model makes its cost read low, but every one of its tokens is still counted, so
  the warning sent people looking for missing data that was never missing. The
  list moved to "Token Watch: Show Diagnostics" under Pricing.
- Switching tabs no longer re-queries the database. Every change of period or
  source cleared the entire result cache and asked the worker again, so going
  back to a tab shown seconds earlier rebuilt it from scratch — 86 ms for Today
  and around 250 ms for Week, Month and Year on a 122 MB database — and the panel
  blanked while it waited, which reads as the extension reloading itself. Results
  are now keyed by the filters that produced them, so a revisit is a lookup and
  costs no query at all.
- A result that has gone stale stays on screen while its refresh runs, instead of
  the numbers disappearing and coming back. Only a tab that has genuinely never
  been opened shows a loading state now.
- Snapshot temp files left behind by interrupted writes are swept when the
  database is opened. Each one is a full copy of the database, and a window
  closed mid-flush leaves one; a month of that had accumulated 32 files and
  1.5 GB in one install, which nothing would ever have reclaimed. A flush that
  fails partway now also removes its own temp file — previously only a failed
  rename did, so a write or fsync error leaked one permanently.
- Rebuilding aggregates no longer discards history it cannot recompute. It
  cleared `daily_aggregate` and `session_aggregate` outright before rebuilding
  them from `usage_record`; with retention pruning old rows, the first rebuild
  would have deleted those days permanently. It now clears only what the
  surviving raw rows can rebuild, and a re-read of the logs cannot resurrect a
  pruned day in fragments either.
- The aggregate integrity check no longer reports a pruned database as corrupt.
  It compares raw rows against the aggregates built from them, and retention
  deliberately keeps aggregates whose rows are gone. Left unscoped it would have
  failed forever, and the worker answers that verdict by rebuilding every
  aggregate on every scan. Found by running retention against a real 122 MB
  database rather than a fixture.

## [0.1.4]

- The Codex and Claude Code usage cards now show your account plan next to the title, for example `Codex Usage (Pro Lite)`.
- The status bar tooltip shows the same plan next to each provider.
- The plan still shows when usage data cannot be loaded, because it is read from your local sign-in details.
- Top models no longer shows `View all models` when every model is already listed.
- Updated bundled pricing for GPT-5.6 Terra and GPT-5.6 Luna.

## [0.1.3]

- Added bundled pricing for Claude Opus 5.

## [0.1.2]

- Added custom model pricing, with prices entered in USD per 1 million tokens.
- Custom prices can replace bundled prices and update usage costs across the dashboard.
- Cost alerts can now track all usage, Codex only, or Claude Code only.
- Improved language support across the status bar, alerts, and usage insights.

## [0.1.1]

- Added English, Vietnamese, and Japanese language options.
- Added daily, weekly, and monthly cost alerts.
- Added hourly usage charts for recent days.
- Improved usage charts with clearer summaries, comparisons, and token details.
- Made recent usage and top models easier to scan and explore.
- Usage limit information now refreshes more quickly.

## [0.1.0]

- View total tokens, estimated cost, usage count, and trends by day or week.
- Track usage limits for both Codex and Claude Code.
- See the most-used models, their token usage, and estimated costs.
- Track tool calls, with separate figures for Codex and Claude Code.
- Quickly view today's token usage and cost in the status bar.
- Improved cost accuracy and usage-data updates.
- Added diagnostic information to make data checks easier when needed.

## [0.0.8]

- Added bundled pricing for GPT-5.6 Sol, Terra, and Luna.
- Added bundled pricing for Claude Fable 5 and Claude Sonnet 5, including cache-hit rates.
- Added Cache writes pricing for the new GPT-5.6 and Claude models; Claude rates use 5-minute cache writes.

## [0.0.7]

- Added Codex usage to the Today view and status bar.
- Shows a clear fallback message when Codex usage is unavailable.
- Added regression coverage for the new Codex usage flow.

## [0.0.6]

- Updated bundled pricing for current GPT and Claude models, including GPT-5.4,
  GPT-5.5, GPT-4.1, o-series, Claude Opus/Sonnet/Haiku families, and snapshot
  aliases used by logs.
- Changed pricing overrides to custom-model additions only. Bundled pricing now
  wins for known models, and stale `$fallback` overrides are ignored.
- Added long-context pricing selection for GPT-5.4/GPT-5.5 sessions above the
  272K context threshold, including rebuild support so fresh ingest and aggregate
  rebuilds stay consistent.
- Added a `Show Diagnostics` command with a Markdown report for ignored pricing
  overrides, fallback models, long-context gaps, crossing-midnight sessions,
  event-day versus folder-day drift, and Codex reconciliation warnings.
- Added Codex reconciliation checks between cumulative `total_token_usage`
  snapshots and the deltas ingested from file cursor contributions.
- Improved append handling when a Codex session crosses into long-context pricing,
  forcing a safe reparse instead of mixing normal and long-context rates.
- Fixed the dashboard's initial empty state so it shows loading while the first
  query is pending and surfaces query errors instead of staying on
  `No usage data yet`.
- Added regression coverage for pricing merge policy, GPT/Claude rates,
  long-context pricing, diagnostics, reconciliation, and empty-query handling.

## [0.0.5]

- Improved Linux log discovery by falling back to per-directory watchers when
  recursive `fs.watch` is unavailable, so nested Codex and Claude logs are picked
  up more reliably.
- Broadened Codex discovery to include all `.jsonl` session files under the
  configured sessions root, not only `rollout-*.jsonl` files.
- Changed the default historical backfill cap to unlimited (`0`) so first-time
  collection does not silently skip older logs on new machines or servers.
- Added a `Reset Database` command and sidebar button. It clears stored token
  data, cursors, catalog state, runtime pricing rows, and stale metadata, then
  rebuilds from the available logs.
- Restored `Rescan Logs` as a full rebuild path for manual recovery while keeping
  background watch scans incremental.
- Hardened Codex resume parsing so incremental reads preserve session/model,
  effort, sandbox, approval, and pending tool context across file boundaries.
- Hardened Claude deduplication across repeated request IDs and append overlap,
  including recovery for legacy Claude dedup keys.
- Made reingest safer for active files by keeping the previous good contribution
  until a full reparse succeeds, and by yielding during large ingest batches to
  keep the worker responsive.
- Added regression coverage for Linux watcher fallback, broader discovery,
  parser resume behavior, append-overlap reingest, full reset, and command
  registration.

## [0.0.4]

- Added an hourly `Usage trend` chart to the `today` view, with Tokens, Cost,
  and Turns modes plus peak-hour and active-hour summaries.
- Improved the Tool Calls card so it shows the top tools first and can expand
  to the full tool list.
- Made live updates more reliable while Codex or Claude is writing logs,
  including nested folders and log folders that appear after VS Code starts.
- Made `Rescan logs` lighter by scanning incrementally instead of forcing a
  full rebuild every time.
- Fixed inaccurate Codex totals caused by shared session IDs across files,
  replaced files at the same path, or duplicate streamed records.
- Recalculated dashboard totals after ingest and pricing changes so totals and
  costs stay in sync.
- Hardened the status bar refresh so older or failed refreshes do not overwrite
  newer usage data.

## [0.0.3]

- Fixed live ingestion for active Codex/Claude logs when a JSONL line is still
  being written: incomplete EOF lines no longer advance the cursor past data
  that should be collected later.
- Added recovery for older installations with empty per-file cursors, so
  non-empty log files are reingested instead of being skipped forever.
- Added startup and periodic background collection: Token Watch now scans on
  extension activation, runs a short startup catch-up scan, and continues
  polling every 2 minutes.
- Improved stale-data signaling: the header now shows `Stale` instead of
  `Live` when the newest collected record is not from today.
- Updated current-period and summary cards with clearer token grouping, colored
  input/cache/output token metrics, and delta colors for zero, negative, and
  positive changes.
- Removed the "of this tab's cost" label from overview cards.
- Added regression coverage for partial JSONL EOF handling and empty-cursor
  reingestion.

## [0.0.2]

- Added a dedicated `today` period as the default dashboard view, with focused
  daily usage insights instead of one-bucket trend/recent-period cards.
- Updated period comparisons:
  - `day` compares the last 7 days.
  - `week` compares the last 7 weeks.
  - `month` compares the last 6 months.
  - `year` compares the last 2 years.
- Improved live refresh while Codex or Claude Code is actively writing logs:
  changed files are ingested first, directory watch events are expanded to the
  relevant JSONL files, and missed path events fall back to a full scan.
- Reduced the default watch debounce from 2000ms to 500ms for faster live
  updates.
- Added queueing for ingestion and pricing updates to avoid overlapping store
  mutations during rapid file changes.
- Improved Claude log discovery to include nested JSONL files such as subagent
  logs.
- Enhanced the status bar tooltip with today's input, output, reasoning, cache
  read, cache write, total tokens, turns, and cost.
- Removed the duplicate footer "Refresh data" action and clarified the header
  action as "Rescan logs".
- Added regression coverage for period windows and changed-path log discovery.

## [0.0.1]

- Initial release.
- Sidebar dashboard: daily series, per-variant breakdown, top models, session
  leaderboard, token composition, and trend charts, filterable by source/period.
- Status bar item showing today's tokens and cost.
- Local pricing engine with bundled defaults, user overrides, and a configurable
  `$fallback` rate; unknown models are flagged in the UI.
- Incremental ingestion of Codex and Claude session logs via a background worker,
  with a full "Rescan Logs" command.

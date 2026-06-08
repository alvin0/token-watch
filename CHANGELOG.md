# Change Log

All notable changes to the "token-watch" extension will be documented in this file.

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

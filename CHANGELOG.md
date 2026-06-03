# Change Log

All notable changes to the "token-watch" extension will be documented in this file.

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

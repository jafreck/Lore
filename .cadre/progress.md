# CADRE Progress

## Fleet Status
- **Issues**: 19 total | 13 completed | 0 in-progress | 5 failed | 0 blocked | 0 not-started | 0 budget-exceeded
- **PRs Created**: 10
- **Token Usage**: 0 / 500,000
- **Last Updated**: 2026-02-28T07:40:55.119Z

## Issues

| Issue | Title | Status | Phase | PR |
|-------|-------|--------|-------|----|
| #36 | Add LLM notes store (kb_notes_write / kb_notes_read) for cached insights | ❌ failed | 0/5 | — |
| #35 | Add kb_architecture tool for codebase structure overview | ❌ failed | 1/5 | — |
| #34 | Add kb_commit_stats tool for commit pattern analytics | ❌ failed | 0/5 | — |
| #33 | Auto-ingest code coverage data (LCOV / Cobertura) | ❌ failed | 0/5 | — |
| #32 | Add SHA watermark for incremental git ingestion (#26) | ❌ failed | 1/5 | — |
| #31 | Prevent overlapping poller and watcher runs (#23) | ✅ completed | 5/5 | #41 |
| #30 | Remove orphan FTS rows on deleted files (#21) | ✅ completed | 5/5 | #43 |
| #29 | Populate module graph and implement richer cross-language relationship extraction | ✅ completed | 5/5 | #45 |
| #28 | Branch-aware checkout semantics and reindex checkpoints | ✅ completed | 5/5 | #46 |
| #27 | Wrap build() and update() file loops in SQLite transactions | ✅ completed | 5/5 | #42 |
| #26 | Add watermark-based incremental history ingestion | ✅ completed | 5/5 | — |
| #25 | Add tests for deletion refresh, call-edge resolution, and FTS cleanup | 🚫 dep-blocked | 0/5 | — |
| #24 | Fix ESM-incompatible require in kb-server/db.ts and emit degraded-mode warning | ✅ completed | 5/5 | #39 |
| #23 | Add single-flight guard to FilePoller and FileWatcher | ✅ completed | 5/5 | — |
| #22 | Fix manual refresh deletion detection in CLI | ✅ completed | 5/5 | #40 |
| #21 | Fix FTS5 orphans on file deletion in update() | ✅ completed | 5/5 | — |
| #20 | Call ingestGitHistory() in update() when history is enabled | ✅ completed | 5/5 | #38 |
| #19 | Call embedStructural() in update() when embedder is configured | ✅ completed | 5/5 | #37 |
| #18 | Invoke buildCallGraph() in build() and update() (branch-scoped) | ✅ completed | 5/5 | #44 |

## Event Log

- `07:22:30` Fleet started: 19 issues


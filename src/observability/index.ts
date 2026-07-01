/**
 * archetype/observability — shared telemetry for autonomous-loop consumers.
 *
 * Two pieces today:
 *   — createTurnReporter: onTurn hook that writes errors.jsonl +
 *     diagnostics.md and emits loud stderr callouts. Replaces the
 *     inline onTurn boilerplate every benchmark harness wrote.
 *   — renderRunMarkdown: pure renderer that turns a collection of
 *     prompt traces + errors + score into a turn-by-turn markdown
 *     report. Host CLI owns file I/O (where traces come from, where
 *     the report gets written).
 */
export * from './turn-reporter.js'
export * from './render-run-markdown.js'

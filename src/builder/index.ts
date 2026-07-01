/**
 * archetype/builder — coder-persona primitives.
 *
 * What belongs here: action contracts, result shapes, Sandbox
 * interface + default SRT impl, BrowserHarness interface + default
 * playwright impl, the builder-action executor that dispatches a
 * parsed action against a (sandbox, browser) pair.
 *
 * What does NOT belong here: benchmark-specific orchestration (run
 * records, evidence layouts, customer reviewers, hidden tests) —
 * those live with the consumer.
 *
 * This module is introduced in the 2026-04-22 promotion to move what
 * every coding-agent consumer needs from `foundry` (their benchmark
 * harness) into `archetype` (the SDK). See
 * memory/project_foundry_session_20260421.md for the background.
 */
export * from './actions.js'
export * from './sandbox.js'
export * from './browser.js'
export * from './executor.js'
export * from './workspace-files.js'
export * from './node-test-discovery.js'

/**
 * @module benchmark
 *
 * Lore benchmark library.
 *
 * Provides infrastructure for evaluating Lore's impact on agent performance:
 * - Repo downloading and management
 * - Lore indexing of benchmark repos
 * - Tool provisioning for control, semantic-baseline, and lore-enabled arms
 * - Scripted and programmatic agent harnesses
 * - Automatic scoring and aggregate reporting
 * - Predefined benchmark tasks from the question catalog
 */

export type {
  RepoSpec,
  RepoInstance,
  BenchmarkArm,
  TaskFamily,
  BenchmarkTask,
  AgentTool,
  ToolCallRecord,
  AgentTrace,
  BenchmarkAgent,
  RunScore,
  BenchmarkRunResult,
  BenchmarkSuiteConfig,
} from './types.js';

export { RepoManager } from './repo-manager.js';
export { indexRepo } from './indexer.js';
export { buildToolsForArm } from './tool-providers.js';
export {
  executeToolCall,
  runScriptedAgent,
  runProgrammaticAgent,
  extractLoreToolsCalled,
  type ScriptedStep,
  type ScriptedAgentConfig,
  type ProgrammaticAgentConfig,
  type AgentStrategy,
  type ToolCallRequest,
} from './agent.js';
export {
  scoreRun,
  aggregateScores,
  formatReport,
  compareReports,
  type AggregateReport,
} from './scorer.js';
export { BenchmarkRunner } from './runner.js';
export { runCopilotAgent, type CopilotAgentOptions } from './copilot-agent.js';
export { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from './strategies.js';
export { LORE_SELF_TASKS, getTasksForRepo, getAllTasks } from './tasks.js';
export { PILOT_REPOS, isPending } from './repos.js';

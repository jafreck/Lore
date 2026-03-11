/**
 * @module benchmark/runner
 *
 * Orchestrates full benchmark runs: repo preparation → indexing → tool
 * provisioning → agent execution → scoring → reporting.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BenchmarkArm,
  BenchmarkRunResult,
  BenchmarkSuiteConfig,
  BenchmarkTask,
  RepoSpec,
} from './types.js';
import { RepoManager } from './repo-manager.js';
import { indexRepo } from './indexer.js';
import { buildToolsForArm } from './tool-providers.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from './scorer.js';
import type { AgentTrace } from './types.js';
import type { ScriptedAgentConfig, ProgrammaticAgentConfig } from './agent.js';
import { runScriptedAgent, runProgrammaticAgent } from './agent.js';
import { runCopilotAgent, type CopilotAgentOptions } from './copilot-agent.js';

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BenchmarkSuiteConfig = {
  arms: ['control', 'lore-enabled'],
  seeds: [42, 123],
  downloadConcurrency: 2,
  workDir: join(process.cwd(), '.benchmark-repos'),
  outputDir: join(process.cwd(), '.benchmark-results'),
};

// ─── BenchmarkRunner ──────────────────────────────────────────────────────────

export class BenchmarkRunner {
  private readonly config: BenchmarkSuiteConfig;
  private readonly repoManager: RepoManager;
  private readonly results: BenchmarkRunResult[] = [];

  constructor(config?: Partial<BenchmarkSuiteConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.repoManager = new RepoManager(this.config.workDir);
    mkdirSync(this.config.outputDir, { recursive: true });
  }

  /**
   * Prepare a repo for benchmarking: download and index.
   */
  async prepareRepo(spec: RepoSpec): Promise<void> {
    // Clone / reset to pinned SHA
    let instance = await this.repoManager.prepare(spec);

    // Index with Lore (needed for lore-enabled and semantic-baseline arms)
    if (!instance.indexed) {
      instance = await indexRepo(instance);
      // Update the instance in the manager
      (this.repoManager as any).instances.set(spec.name, instance);
    }
  }

  /**
   * Run a single task under a specific arm with a scripted agent.
   */
  async runScripted(
    task: BenchmarkTask,
    arm: BenchmarkArm,
    seed: number,
    agentConfig: ScriptedAgentConfig,
  ): Promise<BenchmarkRunResult> {
    const instance = this.repoManager.get(task.repoName);
    if (!instance) throw new Error(`Repo "${task.repoName}" not prepared`);

    const dbPath = arm !== 'control' ? instance.dbPath : undefined;
    const tools = await buildToolsForArm(arm, instance.localPath, dbPath);

    const startedAt = Date.now();
    const startPerf = performance.now();

    let trace: AgentTrace;
    let error: string | undefined;

    try {
      trace = await runScriptedAgent(agentConfig, tools);
    } catch (e: any) {
      error = e.message;
      trace = { toolCalls: [], filesRead: [], finalAnswer: '', totalTokensEstimate: 0, loreToolsCalled: [] };
    }

    const wallTimeMs = Math.round(performance.now() - startPerf);
    const score = scoreRun(task, trace, wallTimeMs);

    const result: BenchmarkRunResult = {
      runId: randomUUID(),
      repoName: task.repoName,
      taskId: task.id,
      taskFamily: task.family,
      arm,
      seed,
      repoSha: instance.spec.sha,
      trace,
      score,
      startedAt,
      completedAt: Date.now(),
      error,
    };

    this.results.push(result);
    return result;
  }

  /**
   * Run a single task under a specific arm with a programmatic agent.
   */
  async runProgrammatic(
    task: BenchmarkTask,
    arm: BenchmarkArm,
    seed: number,
    agentConfig: ProgrammaticAgentConfig,
  ): Promise<BenchmarkRunResult> {
    const instance = this.repoManager.get(task.repoName);
    if (!instance) throw new Error(`Repo "${task.repoName}" not prepared`);

    const dbPath = arm !== 'control' ? instance.dbPath : undefined;
    const tools = await buildToolsForArm(arm, instance.localPath, dbPath);

    const startedAt = Date.now();
    const startPerf = performance.now();

    let trace: AgentTrace;
    let error: string | undefined;

    try {
      trace = await runProgrammaticAgent(agentConfig, task, tools);
    } catch (e: any) {
      error = e.message;
      trace = { toolCalls: [], filesRead: [], finalAnswer: '', totalTokensEstimate: 0, loreToolsCalled: [] };
    }

    const wallTimeMs = Math.round(performance.now() - startPerf);
    const score = scoreRun(task, trace, wallTimeMs);

    const result: BenchmarkRunResult = {
      runId: randomUUID(),
      repoName: task.repoName,
      taskId: task.id,
      taskFamily: task.family,
      arm,
      seed,
      repoSha: instance.spec.sha,
      trace,
      score,
      startedAt,
      completedAt: Date.now(),
      error,
    };

    this.results.push(result);
    return result;
  }

  /**
   * Run a single task under a specific arm using the real Copilot CLI agent.
   */
  async runCopilot(
    task: BenchmarkTask,
    arm: BenchmarkArm,
    seed: number,
    options: CopilotAgentOptions,
  ): Promise<BenchmarkRunResult> {
    const instance = this.repoManager.get(task.repoName);
    if (!instance) throw new Error(`Repo "${task.repoName}" not prepared`);

    const dbPath = arm !== 'control' ? instance.dbPath : undefined;
    const startedAt = Date.now();
    const startPerf = performance.now();

    let trace: AgentTrace;
    let error: string | undefined;

    try {
      trace = await runCopilotAgent(task, arm, instance.localPath, dbPath, options);
    } catch (e: any) {
      error = e.message;
      trace = { toolCalls: [], filesRead: [], finalAnswer: '', totalTokensEstimate: 0, loreToolsCalled: [] };
    }

    const wallTimeMs = Math.round(performance.now() - startPerf);
    const score = scoreRun(task, trace, wallTimeMs);

    const result: BenchmarkRunResult = {
      runId: randomUUID(),
      repoName: task.repoName,
      taskId: task.id,
      taskFamily: task.family,
      arm,
      seed,
      repoSha: instance.spec.sha,
      trace,
      score,
      startedAt,
      completedAt: Date.now(),
      error,
    };

    this.results.push(result);
    return result;
  }

  /**
   * Get all results collected so far.
   */
  getResults(): BenchmarkRunResult[] {
    return [...this.results];
  }

  /**
   * Get results filtered by arm.
   */
  getResultsByArm(arm: BenchmarkArm): BenchmarkRunResult[] {
    return this.results.filter((r) => r.arm === arm);
  }

  /**
   * Generate aggregate reports for each arm and comparison.
   */
  generateReport(): string {
    const arms = [...new Set(this.results.map((r) => r.arm))];
    const reports = arms.map((arm) => {
      const scores = this.results.filter((r) => r.arm === arm).map((r) => r.score);
      return aggregateScores(arm, scores);
    });

    const sections: string[] = [];

    sections.push('═══ Benchmark Results ═══\n');

    for (const report of reports) {
      sections.push(formatReport(report));
      sections.push('');
    }

    // Pairwise comparisons against control
    const controlReport = reports.find((r) => r.arm === 'control');
    if (controlReport) {
      for (const treatment of reports) {
        if (treatment.arm === 'control') continue;
        sections.push(compareReports(controlReport, treatment));
        sections.push('');
      }
    }

    return sections.join('\n');
  }

  /**
   * Persist all results and report to the output directory.
   */
  saveResults(): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(this.config.outputDir, timestamp);
    mkdirSync(dir, { recursive: true });

    // Write raw results
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify(this.results, null, 2),
    );

    // Write report
    writeFileSync(join(dir, 'report.txt'), this.generateReport());

    // Write per-task detail
    for (const result of this.results) {
      const taskDir = join(dir, 'tasks', result.taskId);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(taskDir, `${result.arm}-seed${result.seed}.json`),
        JSON.stringify(result, null, 2),
      );
    }
  }

  /**
   * Clean up: remove repo checkouts.
   */
  async cleanup(): Promise<void> {
    await this.repoManager.removeAll();
  }
}

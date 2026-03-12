export type BenchmarkArm = 'control' | 'semantic-baseline' | 'lore-enabled';

export type TaskFamily =
  | 'localization'
  | 'explanation'
  | 'modification'
  | 'refactoring'
  | 'testing'
  | 'history'
  | 'coverage';

export interface BenchmarkTask {
  id: string;
  repoName: string;
  family: TaskFamily;
  prompt: string;
  questionId?: string;
  expectedAnswerParts: string[];
  expectedAnswer: string;
  expectedFiles?: string[];
  expectedSymbols?: string[];
  timeBudgetSeconds?: number;
  maxToolCalls?: number;
}

export interface AgentTool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  timestamp: number;
}

export interface AgentTrace {
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  finalAnswer: string;
  totalTokensEstimate: number;
  loreToolsCalled: string[];
  rawOutput?: string;
}

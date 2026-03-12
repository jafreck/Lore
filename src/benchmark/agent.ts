import type { ToolCallRecord } from './types.js';

/** Extract unique Lore tool names from a set of tool call records. */
export function extractLoreToolsCalled(toolCalls: ToolCallRecord[]): string[] {
  const loreNames = new Set<string>();
  for (const call of toolCalls) {
    if (call.toolName.startsWith('lore_') && call.result !== 'not available in this configuration') {
      loreNames.add(call.toolName);
    }
  }
  return [...loreNames];
}

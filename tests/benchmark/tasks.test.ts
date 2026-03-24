/**
 * Unit tests for benchmark task definitions.
 */

import { describe, it, expect } from 'vitest';
import { getTasksForRepo, getAllTasks } from './util/tasks.js';

const LORE_SELF_TASKS = getTasksForRepo('lore-self');

describe('LORE_SELF_TASKS', () => {
  it('should have unique task IDs', () => {
    const ids = LORE_SELF_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should all target the lore-self repo', () => {
    for (const task of LORE_SELF_TASKS) {
      expect(task.repoName).toBe('lore-self');
    }
  });

  it('should have non-empty prompts', () => {
    for (const task of LORE_SELF_TASKS) {
      expect(task.prompt.length).toBeGreaterThan(10);
    }
  });

  it('should have at least one expected answer part', () => {
    for (const task of LORE_SELF_TASKS) {
      expect(task.expectedAnswer.length).toBeGreaterThan(0);
    }
  });

  it('should cover multiple task families', () => {
    const families = new Set(LORE_SELF_TASKS.map((t) => t.family));
    expect(families.size).toBeGreaterThanOrEqual(4);
  });

  it('should cover multiple question categories', () => {
    const categories = new Set(
      LORE_SELF_TASKS.filter((t) => t.questionId).map((t) => t.questionId!.split('.')[0]),
    );
    expect(categories.size).toBeGreaterThanOrEqual(3);
  });

  it('should have at least 10 tasks', () => {
    expect(LORE_SELF_TASKS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('getTasksForRepo', () => {
  it('should return tasks for lore-self', () => {
    const tasks = getTasksForRepo('lore-self');
    expect(tasks.length).toBe(LORE_SELF_TASKS.length);
  });

  it('should return tasks for postgres', () => {
    const tasks = getTasksForRepo('postgres');
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('should return empty for unknown repo', () => {
    const tasks = getTasksForRepo('nonexistent');
    expect(tasks).toEqual([]);
  });
});

describe('getAllTasks', () => {
  it('should return all tasks', () => {
    const all = getAllTasks();
    expect(all.length).toBeGreaterThanOrEqual(LORE_SELF_TASKS.length);
  });
});

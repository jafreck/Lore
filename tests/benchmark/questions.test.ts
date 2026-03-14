/**
 * Unit tests for the centralized benchmark question catalog.
 */

import { describe, it, expect } from 'vitest';
import {
  QUESTION_CATALOG,
  getQuestion,
  getQuestionIds,
  getCategories,
  renderPrompt,
  type QuestionParams,
  type RepoContext,
} from './util/questions.js';

describe('QUESTION_CATALOG', () => {
  it('should have unique question IDs', () => {
    const ids = QUESTION_CATALOG.map((q) => q.questionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have non-empty prompt templates', () => {
    for (const q of QUESTION_CATALOG) {
      expect(q.promptTemplate.length).toBeGreaterThan(20);
    }
  });

  it('should have a category for every question', () => {
    for (const q of QUESTION_CATALOG) {
      expect(q.category.length).toBeGreaterThan(0);
    }
  });

  it('should have a description for every question', () => {
    for (const q of QUESTION_CATALOG) {
      expect(q.description.length).toBeGreaterThan(0);
    }
  });

  it('should have at least one Lore tool per question', () => {
    for (const q of QUESTION_CATALOG) {
      expect(q.loreTools.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should have a loreAdvantage note per question', () => {
    for (const q of QUESTION_CATALOG) {
      expect(q.loreAdvantage.length).toBeGreaterThan(0);
    }
  });

  it('should cover multiple categories', () => {
    const cats = new Set(QUESTION_CATALOG.map((q) => q.category));
    expect(cats.size).toBeGreaterThanOrEqual(5);
  });

  it('should cover multiple task families', () => {
    const families = new Set(QUESTION_CATALOG.map((q) => q.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
  });
});

describe('getQuestion', () => {
  it('should return a template for a valid ID', () => {
    const q = getQuestion('1.1');
    expect(q).toBeDefined();
    expect(q!.questionId).toBe('1.1');
  });

  it('should return undefined for unknown ID', () => {
    expect(getQuestion('99.99')).toBeUndefined();
  });
});

describe('getQuestionIds', () => {
  it('should return all IDs in catalog order', () => {
    const ids = getQuestionIds();
    expect(ids.length).toBe(QUESTION_CATALOG.length);
    expect(ids[0]).toBe(QUESTION_CATALOG[0]!.questionId);
  });
});

describe('getCategories', () => {
  it('should return unique categories in catalog order', () => {
    const cats = getCategories();
    expect(new Set(cats).size).toBe(cats.length);
    expect(cats.length).toBeGreaterThanOrEqual(5);
  });
});

describe('renderPrompt', () => {
  const params: QuestionParams = {
    symbol: 'openDb',
    file: 'src/db/schema.ts',
    expectedAnswer: 'build\nupdate',
    expectedAnswerParts: ['build', 'update'],
  };

  const repo: RepoContext = {
    languageLabel: 'TypeScript',
    sourceRoot: 'src/',
  };

  it('should replace {{symbol}} placeholder', () => {
    const q = getQuestion('1.1')!;
    const prompt = renderPrompt(q, params, repo);
    expect(prompt).toContain('`openDb`');
    expect(prompt).not.toContain('{{symbol}}');
  });

  it('should replace {{file}} placeholder', () => {
    const q = getQuestion('1.4')!;
    const prompt = renderPrompt(q, params, repo);
    expect(prompt).toContain('`src/db/schema.ts`');
    expect(prompt).not.toContain('{{file}}');
  });

  it('should leave prompts unchanged when no placeholders are present', () => {
    const q = getQuestion('6.1')!;
    const prompt = renderPrompt(q, params, repo);
    // 6.1 has no placeholders — prompt should match the template exactly
    expect(prompt).toBe(q.promptTemplate);
  });

  it('should produce identical prompts to the old lambda-based approach', () => {
    // Verify that renderPrompt for question 1.1 produces the same result
    // as the original inline lambda: `What functions or methods directly call \`${p.symbol}\`? ...`
    const q = getQuestion('1.1')!;
    const prompt = renderPrompt(q, params, repo);
    expect(prompt).toContain('What functions or methods directly call `openDb`?');
  });
});

# Restore Q6.1 — Top 5 by Cyclomatic Complexity

## Background

Q6.1 was the benchmark's strongest token-efficiency showcase: on the lore-self repo, Lore answered with a single `lore_metrics(limit=5)` call using **173 tokens** vs the control's **5,893 tokens** (bash file scanning) — a **97% reduction** and **8.8x faster** wall time. The question was removed during the question-catalog redesign but the strategy code still exists.

### Historical data (commit `89a2067`, 3 iterations on lore-self)

| Metric   | Control | Lore    | Delta    |
|----------|---------|---------|----------|
| Correct. | 0.67    | **1.00**| **+0.33**|
| Tokens   | 5,893   | **173** | **−97%** |
| Wall     | 131.8s  | **15.0s**| **−89%**|

## What already exists

- **`lore_metrics` tool** — still present in `src/server/tools/metrics.ts`; returns symbols ranked by cyclomatic complexity.
- **Lore strategy for 6.1** — `buildLoreStrategy` in `tests/benchmark/util/strategies.ts` already routes `questionId === '6.1'` to `complexityLoreSteps` (calls `lore_metrics` with `limit: 5`). Also mapped in the dynamic strategy at line ~637.
- **Strategy test** — `tests/benchmark/strategies.test.ts` has a 6.1 expectation that would become active once the catalog entry returns.

## Changes needed

### 1. Add `QuestionTemplate` to `QUESTION_CATALOG` in `tests/benchmark/util/questions.ts`

Append to the `QUESTION_CATALOG` array (after the last entry, before the closing `]`):

```typescript
{
  questionId: '6.1',
  category: 'Complexity',
  family: 'coverage',          // matches historical family; TaskFamily already includes 'coverage'
  description: 'Top 5 most complex symbols by cyclomatic complexity',
  promptTemplate:
    'List the top 5 most complex functions or methods in this {{languageLabel}} codebase, ' +
    'ranked by cyclomatic complexity. For each, give the symbol name, file path, and ' +
    'cyclomatic complexity score.',
  loreTools: ['lore_metrics'],
  loreAdvantage:
    'lore_metrics queries pre-indexed symbol_metrics table in one call; ' +
    'control must scan every file with bash/grep and compute complexity manually.',
},
```

### 2. Add per-repo answer data in `tests/benchmark/util/tasks.ts`

For each repo's `questions` map, add a `'6.1'` entry. The entry **does not** need `symbol` or `file` (complexity is repo-global). Populate `expectedAnswer` and `expectedAnswerParts` from actual `lore_metrics` output against that repo's index.

#### Generating ground truth

For each repo, run `lore_metrics` against the indexed DB:

```sql
SELECT s.name, f.path, s.cyclomatic
FROM symbols s
JOIN files f ON f.id = s.file_id
WHERE s.cyclomatic IS NOT NULL
ORDER BY s.cyclomatic DESC
LIMIT 5;
```

Or invoke the CLI:

```sh
node dist/cli.js serve  # start MCP server against repo DB
# then call lore_metrics with limit=5
```

#### Template for each repo entry

```typescript
'6.1': {
  symbol: '',       // not symbol-specific
  file: '',         // not file-specific
  expectedAnswer: '<symbol1> in <file1> (cyclomatic: N)\n<symbol2> in <file2> ...',
  expectedAnswerParts: ['<symbol1>', '<symbol2>', '<symbol3>'],
  expectedSymbols: ['<symbol1>', '<symbol2>', '<symbol3>', '<symbol4>', '<symbol5>'],
  expectedFiles: ['<file1>', '<file2>', '<file3>'],
},
```

#### Repos that need entries

| Repo              | File location in `tasks.ts`         |
|-------------------|-------------------------------------|
| lore-self         | `LORE_SELF_ANSWERS.questions`       |
| jackson-databind  | `JACKSON_ANSWERS.questions`         |
| zod               | `ZOD_ANSWERS.questions`             |
| fastapi           | `FASTAPI_ANSWERS.questions`         |
| esbuild           | `ESBUILD_ANSWERS.questions`         |
| postgres          | `POSTGRES_ANSWERS.questions`        |

> **Tip:** Start with lore-self only to validate, then expand to all 6 repos.

### 3. No strategy changes needed

`strategies.ts` already handles `questionId === '6.1'`:

- `buildLoreStrategy` → `complexityLoreSteps` (line ~88)
- `complexityLoreSteps` calls `lore_metrics` with `{ limit: 5 }` (line ~352)
- Dynamic strategy maps 6.1 → `lore_metrics` (line ~637)
- `buildControlStrategy` falls through to default (bash/grep), which is the correct baseline behavior

### 4. Validate

```sh
# Run benchmark for lore-self only, 3 iterations
BENCHMARK_COPILOT=1 BENCHMARK_REPO=lore-self BENCHMARK_ITERATIONS=3 \
  npx vitest run tests/benchmark/copilot-agent.test.ts

# Check that 6.1 appears in results with expected token savings
```

### 5. Update benchmark-results.md

After running across all repos, update the aggregate and per-repo tables in `docs/benchmark-results.md`. The 6.1 result should show up as a standout Lore advantage, likely with 90%+ token savings.

## Why this question matters

Q6.1 is the purest demonstration of Lore's value proposition: **one structured query replaces an entire discovery workflow**. The control agent must read files, parse ASTs or count branches, and aggregate — burning thousands of tokens. Lore answers from a pre-indexed table in a single call. This maps directly to the "efficiency" pillar in Lore's README.

# Lore Benchmark Plan

Measure Lore's causal impact on agent performance on real large-codebase tasks.

Primary question:

- Does Lore improve agent success, speed, cost, and navigation efficiency versus non-Lore baselines?

Secondary questions:

- Which task families benefit most?
- Which Lore capabilities are most associated with gains?
- Which repo characteristics correlate with larger gains?

---

## Core evaluation principle

Run the same tasks on the same repos with the same agent configuration under different retrieval conditions.

## Comparison arms

### Required arms

1. **Control**
   - Agent has standard local repo tools only:
     - file read
     - grep/text search
     - directory listing
     - terminal/test execution as allowed
   - No Lore tools.
   - Stub tool entries matching Lore tool names are registered but return `"not available in this configuration"` — this equalizes tool-description prompting across arms so that tool names like `lore_graph` or `lore_test_map` do not implicitly steer reasoning in the Lore arm only.

2. **Semantic baseline**
   - Same tools as Control.
   - Generic embedding-based code search over file chunks (e.g., FAISS index built from overlapping ~512-token windows of every source file).
   - No structural, graph, history, or coverage tools.
   - Purpose: isolate Lore's structural/graph/history value from its embedding/search value. Without this arm, positive results face the objection "you compared it to grep."

3. **Lore-enabled**
   - Same tools as Control (real, not stubs).
   - Lore MCP tools enabled.

### Optional later ablations

Only after the main benchmark is working:

4. **Lore-lite**
   - Limited Lore surface such as `lore_lookup`, `lore_search`, `lore_snippet`

5. **Lore-full**
   - Full Lore surface including graph/history/docs/test/coverage/architecture tools

For the main study, Control vs Semantic baseline vs Lore-enabled is the core comparison. The Control vs Lore-enabled pair is sufficient for the pilot.

---

## What to evaluate

## 1. Repo panel

Use a broad repo suite stratified by size, language, and structure.

### Target dimensions

- **Size**
  - Medium: 20k–100k LOC
  - Large: 100k–500k LOC
  - Very large: 500k+ LOC

- **Language mix**
  - TS/JS
  - Python
  - Go
  - Java/Kotlin
  - Rust
  - Polyglot monorepos

- **Structure**
  - Service repo
  - Web app
  - CLI/tooling repo
  - SDK/library
  - Monorepo

- **Metadata quality**
  - Strong docs/tests
  - Weak docs/tests

- **History richness**
  - High churn
  - Stable codebase

### Recommended panel size

- Pilot: 3–5 repos
- Main benchmark: 12+ repos
- Stronger claims: 20–30 repos

### Selection guidance

Include repos with:
- nontrivial call depth
- cross-module dependencies
- enough tests or validation commands
- meaningful commit history
- realistic navigation burden

---

## 2. Task panel

Use multiple task families, not only bug fixes.

### A. Localization tasks
Examples:
- Identify where a feature is implemented
- Find the owning symbol/file for behavior X
- Find the handler or call path for API Y

### B. Explanation tasks
Examples:
- Explain how request X flows through the system
- Summarize module responsibilities
- Explain why a file changed recently

### C. Modification tasks
Examples:
- Add logging or validation in the correct path
- Extend a small feature
- Fix a scoped defect with acceptance tests

### D. Refactoring tasks
Examples:
- Rename or relocate a concept
- Replace a deprecated API
- Update all call sites
- Extract a shared helper

### E. Testing tasks
Examples:
- Identify relevant tests for a source file
- Add a regression test
- Repair failing tests after a change

### F. History/ownership tasks
Examples:
- Find when behavior changed
- Identify likely owners
- Explain a recent regression

### G. Coverage/risk tasks
Examples:
- Identify risky uncovered areas
- Propose smallest safe change region
- Prioritize test additions

### Recommended counts

- 8–12 tasks per repo
- 100+ total task instances for an initial main study
- Balanced across families

---

## Task sourcing strategy

Use multiple sources to avoid overfitting.

### Source 1: Real historical tasks
Derived from:
- closed issues
- merged PRs
- bugfix commits
- regressions/postmortems

Method:
- freeze the repo at the commit before the fix
- give the agent only the task description
- score whether it reaches the intended fix or a valid equivalent

### Source 2: Synthetic but repo-grounded tasks
Generated from real repo structure, for example:
- "Find endpoint handling X"
- "Add validation to config parser"
- "Update all callers of Y"
- "Add tests for uncovered branch in module Z"

These should be grounded in actual code, not invented abstractions.

**Bias control:** Synthetic tasks must be authored or reviewed by someone unfamiliar with Lore's tool surface. Audit the final synthetic task set against the Lore tool list and ensure no more than 30% of synthetic tasks directly correspond to a single Lore tool's optimal query pattern. Include tasks that require multi-hop reasoning Lore doesn't shortcut (e.g., "Find the root cause of this test flake" requires understanding timing, not just call graphs).

### Source 3: Maintainer-authored tasks
Ask maintainers for representative tasks per repo.

### Recommended mix

- 40% historical
- 40% synthetic grounded
- 20% maintainer-authored

---

## Experimental design

## Unit of analysis

One run = one agent attempt on one repo-task pair under one arm.

## Randomization

For each repo-task pair:
- run the same prompt in all arms
- randomize arm order
- randomize task order
- use multiple seeds per arm

Recommended:
- 2 seeds for pilot
- 3 seeds for main benchmark

## Context isolation

Each run must use a **fresh context window** with no carry-over from previous tasks on the same repo. If the system under test is stateful (e.g., cached conversation history, persistent agent memory), explicitly flush state between runs. This prevents later tasks from benefiting from knowledge accumulated during earlier tasks.

## Agent standardization

Hold fixed across arms:
- same model and exact model version/checkpoint identifier
- same system prompt (including equal high-level guidance such as "consider architecture, test coverage, history" in all arms)
- same task prompt template
- same context budget
- same token limits
- same time budget
- same edit permissions
- same validation permissions

Only retrieval/tool availability changes.

**Model version pinning:** Record the exact model version/checkpoint identifier (not just the model name). Ideally run all arms for a given repo-task pair within the same 24-hour window to minimize model drift from provider-side updates.

## Environment control

Each run should use:
- pinned repo SHA
- fresh checkout or clean reset
- identical dependency state
- identical test/build environment
- isolated artifacts where possible

This avoids contamination across arms.

## Time budget

Use bounded execution, but calibrate budgets empirically in the pilot.

Default starting points:
- localization/explanation: 20 minutes or 50 tool actions
- modification/refactor/testing: 45 minutes or 150 tool actions

**Budget calibration:** During the pilot, verify that both arms can typically finish within budget on at least 80% of tasks. If Lore tool calls consume disproportionate budget due to latency, adjust upward. Report results both with and without budget caps so that budget-induced truncation effects are visible.

---

## Metrics

Use a small set of primary metrics and a broader secondary set.

## Primary outcome metrics

### 1. Task success rate
Score per run:
- `0`: failed
- `0.5`: partial
- `1`: success

Define success separately by task family before running the benchmark.

Examples:
- localization: correct file/symbol/path found
- explanation: accurate explanation per rubric
- modification: change satisfies spec and tests pass
- refactor: required usages updated and tests pass
- testing: relevant test added/updated and meaningful
- history: correct commit/owner/change rationale identified

### 2. Time to success
Wall-clock time until successful completion.

### 3. Tool-adjusted cost
Capture:
- total tokens
- prompt tokens
- completion tokens
- tool calls
- file reads
- terminal/test runs

### 4. First-pass accuracy
Whether the first proposed target file/symbol/change was correct.

This is especially relevant in large repos.

---

## Secondary process metrics

### Navigation efficiency
- files opened
- unique files opened
- lines read
- dead-end files
- backtracks
- time to first correct file
- time to first correct symbol

### Decisiveness
- number of candidate files/symbols considered before the final answer
- trace length normalized by task complexity
- ratio of exploratory actions to committed actions

This captures whether Lore makes the agent more *decisive* — committing to an answer in fewer steps rather than hedging, backtracking, or producing long exploratory traces.

### Retrieval quality
For tasks with known targets:
- whether the relevant file/symbol appeared early in retrieval
- Recall@k
- MRR where applicable

### Edit efficiency
- files edited
- unnecessary edits
- revert rate
- validation iterations

### Validation efficiency
- number of test runs
- time to first relevant test
- irrelevant test execution rate

### Robustness
- variance across seeds
- variance across repos
- failure modes by task family

---

## Human and automatic scoring

Use automatic scoring wherever possible.

## Automatic scoring
Best for:
- modification
- refactor
- testing
- exact localization
- many history tasks

Signals:
- tests pass
- expected invariants hold
- touched files overlap target files
- required symbol usages updated
- answer key matched where appropriate

## Rubric scoring
Needed for:
- architecture explanations
- root-cause explanations
- comparative summaries

Use blinded review:
- reviewers do not know the arm
- 2 reviewers per artifact
- adjudicate disagreements

Rubric dimensions:
- factual correctness
- completeness
- specificity
- usefulness

### Inter-rater reliability

Compute Cohen's kappa or Krippendorff's alpha on rubric scores during the pilot. Target κ ≥ 0.6. If below, refine the rubric before the main study.

Consider using LLM-as-judge for a cheap first-pass score, calibrated against a human-scored subset (≥20 artifacts). If LLM-judge agreement with humans reaches κ ≥ 0.7, it can replace one of the two human reviewers for the main study.

---

## Instrumentation requirements

Capture the full agent trajectory for every run.

For each run, log:
- repo name
- pinned commit SHA
- task ID
- task family
- arm
- model name and exact version/checkpoint
- seed
- start/end timestamps
- tool calls (with latencies)
- Lore tool calls and arguments
- file reads and paths
- terminal commands
- tests run
- produced patch
- final answer
- validation results
- final score
- token counts
- budget remaining at completion

Also compute repo-level descriptors:
- repo size (LOC)
- language mix
- doc density
- test density
- history density (commits per file)
- symbol graph size
- Lore DB size
- Lore index build time

---

## Repo onboarding protocol

Each repo should follow the same setup process.

### Control arm
- clone repo at pinned SHA
- install dependencies
- register stub Lore tool entries (return "not available") to equalize prompting
- expose only standard agent tools

### Semantic baseline arm
- same as Control
- build generic embedding index over source file chunks
- expose embedding search tool alongside standard tools
- same stub Lore tool entries as Control

### Lore-enabled arm
- same repo SHA
- same dependency setup
- build Lore index
- optionally ingest coverage if available
- enable real Lore tools (replacing stubs)

Record:
- indexing time
- indexing failures
- unsupported-language gaps
- embedding availability
- history/docs/coverage availability

### Lore index quality threshold

Define a minimum index quality gate: ≥70% of source files successfully indexed and symbol count > 0 for each major language present in the repo. Below that threshold, flag the repo-arm pair as `lore_degraded` and analyze separately rather than silently including degraded data.

---

## Handling feature heterogeneity

Some repos will lack:
- coverage reports
- strong docs
- rich history
- usable LSP
- full language support

Do not exclude these repos automatically.

Instead annotate capability flags:
- `has_docs`
- `has_history`
- `has_coverage`
- `has_embeddings`
- `has_lsp_enrichment`
- `supported_language_fraction`
- `lore_index_quality` (percentage of files successfully indexed)

Then analyze outcomes conditional on availability.

---

## Statistical analysis plan

Use paired analyses because each task appears in all arms.

## Primary analyses
- paired comparison of success rate: Lore-enabled vs Control, Lore-enabled vs Semantic baseline
- paired comparison of time to success
- paired comparison of token/tool cost

For the main study at 12–20 repos, prefer simpler paired non-parametric tests:
- Wilcoxon signed-rank test on per-task-pair differences
- stratified by task family
- Bonferroni or Holm correction for multiple comparisons across arms

## Model-based analysis

Reserve mixed-effects models for Phase 3 or when the repo panel reaches 20+. The model specification:

$$
Outcome \sim Arm + TaskType + RepoSize + LanguageMix + FeatureAvailability + (1|Repo) + (1|Task)
$$

Examples:
- logistic mixed model for success
- linear or log-linear mixed model for time/cost
- ordinal model for rubric scores

With 12 repos and ~100 task instances, random effects and fixed-effect covariates will be thinly estimated — report both paired tests and model-based results and note agreement or divergence.

## Reporting
For each metric, report:
- mean and median by arm
- effect size (Cohen's d or odds ratio)
- confidence interval
- task-family breakdown
- repo breakdown
- win rate across repo-task pairs

---

## Failure analysis

Tag failed runs with structured labels:
- retrieval miss
- wrong file chosen
- wrong symbol chosen
- shallow reasoning
- stale or incorrect history inference
- over-trust in retrieval result
- edit compiles but fails semantics
- test selection failure
- validation not attempted
- task not completed in budget

Compare failure distributions between arms.

---

## Total cost of ownership analysis

Report not only agent run costs but also the cost of Lore itself.

For each repo, capture:
- Lore index build time (wall-clock and CPU)
- Lore DB size on disk
- embedding compute cost (if applicable)
- incremental re-index time

Report a break-even analysis: "Lore setup cost is amortized after N agent tasks on this repo, assuming M% success rate improvement." This lets adopters decide whether Lore is worthwhile for their usage patterns.

---

## Recommended benchmark slices

### Slice A: Find the right place faster
Use localization + small modification tasks.

Metrics:
- first-pass target accuracy
- files opened
- time to first correct file
- time to success
- decisiveness (candidates considered)

### Slice B: Understand architecture and history
Use explanation + history tasks.

Metrics:
- rubric score
- correct module/commit references
- time to explanation

### Slice C: Change code safely
Use modification + refactor + testing tasks.

Metrics:
- success rate
- tests passed
- unnecessary edits
- validation efficiency

### Slice D: Large monorepo stress test
Use largest repos only.

Metrics:
- navigation efficiency
- cost
- timeout rate
- variance

---

## Recommended phased rollout

## Phase 1: Pilot
Purpose: validate harness, task specs, scoring, and calibrate budgets.

- 3 repos
- 12–18 tasks each
- 2 arms: Control vs Lore-enabled
- 2 seeds

Output:
- feasibility assessment
- ambiguity cleanup
- initial variance estimate
- initial effect size estimate
- budget calibration (verify ≥80% of tasks finish within budget in both arms)
- inter-rater reliability scores (target κ ≥ 0.6 for rubric tasks)
- task spec schema validation

## Phase 2: Main benchmark
Purpose: produce credible comparative results.

- 12–20 repos
- 8–12 tasks per repo
- 3 arms: Control vs Semantic baseline vs Lore-enabled
- 3 seeds

Output:
- primary results with confidence intervals
- task-family breakdown
- repo-type breakdown
- total cost of ownership analysis
- failure mode comparison

## Phase 3: Optional ablation study
Purpose: understand which Lore capabilities matter most.

Possible arms:
- Control
- Semantic baseline
- Lore-lite (search/lookup/snippet only)
- Lore-enabled/full
- history/docs disabled
- graph disabled

Output:
- which categories of Lore capability drive lift
- interaction effects between capabilities and task families

---

## Practical risks and mitigations

| Risk | Mitigation |
|------|------------|
| Task leakage from public historical examples | Pin commits; verify task descriptions don't appear in training data |
| Prompt instability across runs | Fix system prompt, use multiple seeds, report variance |
| Contamination across arms | Fresh context window per run, flush stateful systems |
| Ambiguous success rubrics | Predefine criteria per family; validate IRR in pilot |
| Unsupported-language bias | Annotate `supported_language_fraction`; analyze conditional on coverage |
| Overfitting synthetic tasks to Lore's API surface | Non-Lore author for synthetic tasks; audit ≤30% single-tool correspondence |
| Tool-description prompting confound | Stub tools in Control/Semantic arms equalize tool-name exposure |
| Model version drift | Pin exact checkpoint; run all arms per task within 24h window |
| Lore index silently degraded | Enforce ≥70% index quality gate; flag `lore_degraded` pairs |
| Budget asymmetry from Lore latency | Calibrate budgets in pilot; report with and without caps |

---

## Task spec schema

Define this concretely from Phase 1 to force all downstream components (harness, scorer, analysis) to agree on the contract early.

```yaml
# task-spec.schema.yaml
id: string           # unique task identifier, e.g. "django-loc-001"
repo: string         # repo identifier, e.g. "django/django"
sha: string          # pinned commit SHA
family: enum         # localization | explanation | modification | refactoring | testing | history | coverage
source: enum         # historical | synthetic | maintainer
prompt: string       # task description given to the agent
context: string      # optional additional context (e.g., error message, issue body)
budget:
  max_actions: int   # e.g. 50
  max_minutes: int   # e.g. 20
ground_truth:
  files: list[string]        # expected target files
  symbols: list[string]      # expected target symbols (optional)
  patch: string              # path to reference patch (optional)
  validator: enum            # file_overlap | tests_pass | patch_equivalent | rubric | answer_key
  answer_key: string         # expected answer text for exact-match tasks (optional)
  test_commands: list[string] # commands to validate correctness (optional)
  rubric: string             # path to rubric file for human/LLM scoring (optional)
arms: list[string]           # which arms to run, e.g. ["control", "semantic", "lore"]
tags: list[string]           # optional metadata tags for filtering/slicing
```

Example:

```yaml
id: "django-loc-001"
repo: "django/django"
sha: "a1b2c3d4e5f6"
family: "localization"
source: "historical"
prompt: "Find the file and function that handles CSRF token rotation"
context: ""
budget:
  max_actions: 50
  max_minutes: 20
ground_truth:
  files: ["django/middleware/csrf.py"]
  symbols: ["rotate_token"]
  validator: "file_overlap"
arms: ["control", "semantic", "lore"]
tags: ["security", "middleware"]
```

Ship this schema and a validator script in the pilot.

---

## Minimal implementation architecture

Build five pieces:

1. **Task spec format + validator**
   JSON/YAML describing repo, SHA, prompt, task family, budgets, and validators, plus a schema validator to enforce the contract.

2. **Run harness**
   Executes the same task in all arms, captures traces, and stores outputs. Manages context isolation (fresh window per run), stub tool registration for non-Lore arms, and budget enforcement.

3. **Scoring pipeline**
   Automatic validators plus a rubric queue for human/LLM review. Includes IRR computation for rubric-scored artifacts.

4. **Analysis notebook/report generator**
   Produces per-arm metrics, confidence intervals, failure summaries, and total cost of ownership analysis.

5. **Repo onboarding toolkit**
   Scripts to clone at SHA, install deps, build Lore index, build generic embedding index, compute repo descriptors, and verify index quality gates.

---

## Recommended first implementation scope

Start with the smallest credible version:

- 5 repos
- 30 total tasks
- 2 arms: Control vs Lore-enabled (add Semantic baseline in Phase 2)
- automatic scoring for localization and modification tasks
- full trajectory logging
- concrete task spec schema with validator
- budget calibration pass
- stub tool registration in Control arm

That should be enough to determine whether Lore shows a measurable signal and whether the harness works end-to-end.

#!/usr/bin/env bash
#
# Regenerate pre-built .scip index files for pipeline smoke tests.
#
# Run from the repo root:
#   bash tests/fixtures/scip-projects/regenerate.sh
#
# Prerequisites: install the relevant SCIP indexer for each language.
#   npm install -g @sourcegraph/scip-typescript
#   pip install scip-python
#   go install github.com/sourcegraph/scip-go/cmd/scip-go@latest
#   # etc.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/scip-indexes"
mkdir -p "$OUT_DIR"

# ── TypeScript ──────────────────────────────────────────────────────────────
if command -v scip-typescript &>/dev/null; then
  echo "Generating TypeScript SCIP index..."
  (cd "$SCRIPT_DIR/typescript" && scip-typescript index --output "$OUT_DIR/typescript.scip")
  echo "  → $OUT_DIR/typescript.scip ($(wc -c < "$OUT_DIR/typescript.scip") bytes)"
else
  echo "SKIP: scip-typescript not found"
fi

# ── Python ──────────────────────────────────────────────────────────────────
if command -v scip-python &>/dev/null && [ -d "$SCRIPT_DIR/python" ]; then
  echo "Generating Python SCIP index..."
  (cd "$SCRIPT_DIR/python" && scip-python index . --project-name test --output "$OUT_DIR/python.scip")
  echo "  → $OUT_DIR/python.scip ($(wc -c < "$OUT_DIR/python.scip") bytes)"
else
  echo "SKIP: scip-python not found or no python fixture"
fi

# ── Go ──────────────────────────────────────────────────────────────────────
if command -v scip-go &>/dev/null && [ -d "$SCRIPT_DIR/go" ]; then
  echo "Generating Go SCIP index..."
  (cd "$SCRIPT_DIR/go" && scip-go && mv index.scip "$OUT_DIR/go.scip")
  echo "  → $OUT_DIR/go.scip ($(wc -c < "$OUT_DIR/go.scip") bytes)"
else
  echo "SKIP: scip-go not found or no go fixture"
fi

# ── Java ────────────────────────────────────────────────────────────────────
if command -v coursier &>/dev/null && [ -d "$SCRIPT_DIR/java" ]; then
  echo "Generating Java SCIP index..."
  (cd "$SCRIPT_DIR/java" && coursier launch com.sourcegraph:scip-java_2.13:0.10.3 -- index --output "$OUT_DIR/java.scip")
  echo "  → $OUT_DIR/java.scip ($(wc -c < "$OUT_DIR/java.scip") bytes)"
else
  echo "SKIP: coursier (scip-java) not found or no java fixture"
fi

# ── C# ──────────────────────────────────────────────────────────────────────
if command -v scip-dotnet &>/dev/null && [ -d "$SCRIPT_DIR/csharp" ]; then
  echo "Generating C# SCIP index..."
  (cd "$SCRIPT_DIR/csharp" && scip-dotnet index ScipFixture.csproj --output "$OUT_DIR/csharp.scip")
  echo "  → $OUT_DIR/csharp.scip ($(wc -c < "$OUT_DIR/csharp.scip") bytes)"
else
  echo "SKIP: scip-dotnet not found or no csharp fixture"
fi

# ── Rust ────────────────────────────────────────────────────────────────────
if command -v rust-analyzer &>/dev/null && [ -d "$SCRIPT_DIR/rust" ]; then
  echo "Generating Rust SCIP index..."
  (cd "$SCRIPT_DIR/rust" && rust-analyzer scip . && mv index.scip "$OUT_DIR/rust.scip")
  rm -rf "$SCRIPT_DIR/rust/target" "$SCRIPT_DIR/rust/Cargo.lock"
  echo "  → $OUT_DIR/rust.scip ($(wc -c < "$OUT_DIR/rust.scip") bytes)"
else
  echo "SKIP: rust-analyzer not found or no rust fixture"
fi

echo ""
echo "Done. Available indexes:"
ls -lh "$OUT_DIR"/*.scip 2>/dev/null || echo "  (none)"

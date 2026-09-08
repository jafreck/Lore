#!/usr/bin/env bash
#
# Regenerate pre-built .scip index files for pipeline smoke tests.
#
# Run from the repo root:
#   bash tests/fixtures/scip-projects/regenerate.sh
#
# Prerequisites: use Node.js 22 and install the relevant SCIP indexer for each language.
#   npm install -g @sourcegraph/scip-typescript
#   pip install scip-python
#   go install github.com/sourcegraph/scip-go/cmd/scip-go@latest
#   # scip-clang may also be installed at ~/.lore/bin/scip-clang
#   # etc.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/scip-indexes"
mkdir -p "$OUT_DIR"

TEMP_COMPDBS=()
TEMP_OUTPUTS=()
cleanup() {
  for file in "${TEMP_COMPDBS[@]}"; do
    rm -f "$file"
  done
  for file in "${TEMP_OUTPUTS[@]}"; do
    rm -f "$file"
  done
}
trap cleanup EXIT

find_scip_clang() {
  if command -v scip-clang &>/dev/null; then
    command -v scip-clang
  elif [[ -x "$HOME/.lore/bin/scip-clang" ]]; then
    printf '%s\n' "$HOME/.lore/bin/scip-clang"
  fi
}

ensure_node_22_build() {
  if ! command -v node &>/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]]; then
    echo "ERROR: C/C++ fixture normalization requires Node.js 22 (run: nvm use 22)" >&2
    return 1
  fi
  (cd "$REPO_ROOT" && npm run build >/dev/null)
}

generate_clang_fixture() {
  local language="$1"
  local scip_clang="$2"
  local project_dir="$SCRIPT_DIR/$language"
  local compdb="$project_dir/.fixture-compile-commands.json"
  local output="$OUT_DIR/$language.scip"
  local temp_output="$OUT_DIR/.$language.tmp.$$.$RANDOM.scip"

  TEMP_COMPDBS+=("$compdb")
  TEMP_OUTPUTS+=("$temp_output")
  node "$SCRIPT_DIR/prepare-clang-compdb.mjs" \
    "$project_dir/compile_commands.json" "$compdb" "$project_dir"
  (
    cd "$project_dir"
    "$scip_clang" \
      --compdb-path=.fixture-compile-commands.json \
      --index-output-path="../scip-indexes/$(basename "$temp_output")" \
      --jobs=1 \
      --no-progress-report \
      --log-level=warning
  )
  rm -f "$compdb"
  node "$SCRIPT_DIR/normalize-scip-index.mjs" "$temp_output"
  mv -f "$temp_output" "$output"
  echo "  → $output ($(wc -c < "$output") bytes)"
}

ensure_node_22_build

# ── C / C++ ─────────────────────────────────────────────────────────────────
SCIP_CLANG="$(find_scip_clang || true)"
if [[ -n "$SCIP_CLANG" && -d "$SCRIPT_DIR/c" && -d "$SCRIPT_DIR/cpp" ]]; then
  echo "Generating C SCIP index..."
  generate_clang_fixture c "$SCIP_CLANG"
  echo "Generating C++ SCIP index..."
  generate_clang_fixture cpp "$SCIP_CLANG"
else
  echo "SKIP: scip-clang not found or C/C++ fixtures are missing"
fi

# ── TypeScript ──────────────────────────────────────────────────────────────
if command -v scip-typescript &>/dev/null; then
  echo "Generating TypeScript SCIP index..."
  TS_TEMP="$OUT_DIR/.typescript.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$TS_TEMP")
  (cd "$SCRIPT_DIR/typescript" && scip-typescript index --output "$TS_TEMP")
  mv -f "$TS_TEMP" "$OUT_DIR/typescript.scip"
  echo "  → $OUT_DIR/typescript.scip ($(wc -c < "$OUT_DIR/typescript.scip") bytes)"
else
  echo "SKIP: scip-typescript not found"
fi

# ── Python ──────────────────────────────────────────────────────────────────
if command -v scip-python &>/dev/null && [ -d "$SCRIPT_DIR/python" ]; then
  echo "Generating Python SCIP index..."
  PYTHON_TEMP="$OUT_DIR/.python.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$PYTHON_TEMP")
  (cd "$SCRIPT_DIR/python" && scip-python index . --project-name test --output "$PYTHON_TEMP")
  mv -f "$PYTHON_TEMP" "$OUT_DIR/python.scip"
  echo "  → $OUT_DIR/python.scip ($(wc -c < "$OUT_DIR/python.scip") bytes)"
else
  echo "SKIP: scip-python not found or no python fixture"
fi

# ── Go ──────────────────────────────────────────────────────────────────────
if command -v scip-go &>/dev/null && [ -d "$SCRIPT_DIR/go" ]; then
  echo "Generating Go SCIP index..."
  GO_TEMP="$OUT_DIR/.go.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$GO_TEMP")
  (cd "$SCRIPT_DIR/go" && scip-go && mv index.scip "$GO_TEMP")
  mv -f "$GO_TEMP" "$OUT_DIR/go.scip"
  echo "  → $OUT_DIR/go.scip ($(wc -c < "$OUT_DIR/go.scip") bytes)"
else
  echo "SKIP: scip-go not found or no go fixture"
fi

# ── Java ────────────────────────────────────────────────────────────────────
if command -v coursier &>/dev/null && [ -d "$SCRIPT_DIR/java" ]; then
  echo "Generating Java SCIP index..."
  JAVA_TEMP="$OUT_DIR/.java.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$JAVA_TEMP")
  (cd "$SCRIPT_DIR/java" && coursier launch com.sourcegraph:scip-java_2.13:0.10.3 -- index --output "$JAVA_TEMP")
  mv -f "$JAVA_TEMP" "$OUT_DIR/java.scip"
  echo "  → $OUT_DIR/java.scip ($(wc -c < "$OUT_DIR/java.scip") bytes)"
else
  echo "SKIP: coursier (scip-java) not found or no java fixture"
fi

# ── C# ──────────────────────────────────────────────────────────────────────
if command -v scip-dotnet &>/dev/null && [ -d "$SCRIPT_DIR/csharp" ]; then
  echo "Generating C# SCIP index..."
  CSHARP_TEMP="$OUT_DIR/.csharp.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$CSHARP_TEMP")
  (cd "$SCRIPT_DIR/csharp" && scip-dotnet index ScipFixture.csproj --output "$CSHARP_TEMP")
  mv -f "$CSHARP_TEMP" "$OUT_DIR/csharp.scip"
  echo "  → $OUT_DIR/csharp.scip ($(wc -c < "$OUT_DIR/csharp.scip") bytes)"
else
  echo "SKIP: scip-dotnet not found or no csharp fixture"
fi

# ── Rust ────────────────────────────────────────────────────────────────────
if command -v rust-analyzer &>/dev/null && [ -d "$SCRIPT_DIR/rust" ]; then
  echo "Generating Rust SCIP index..."
  RUST_TEMP="$OUT_DIR/.rust.tmp.$$.$RANDOM.scip"
  TEMP_OUTPUTS+=("$RUST_TEMP")
  (cd "$SCRIPT_DIR/rust" && rust-analyzer scip . && mv index.scip "$RUST_TEMP")
  mv -f "$RUST_TEMP" "$OUT_DIR/rust.scip"
  rm -rf "$SCRIPT_DIR/rust/target" "$SCRIPT_DIR/rust/Cargo.lock"
  echo "  → $OUT_DIR/rust.scip ($(wc -c < "$OUT_DIR/rust.scip") bytes)"
else
  echo "SKIP: rust-analyzer not found or no rust fixture"
fi

echo "Canonicalizing all SCIP fixture metadata..."
for index_file in "$OUT_DIR"/*.scip; do
  [[ -e "$index_file" ]] || continue
  node "$SCRIPT_DIR/normalize-scip-index.mjs" "$index_file"
done

echo ""
echo "Done. Available indexes:"
ls -lh "$OUT_DIR"/*.scip 2>/dev/null || echo "  (none)"

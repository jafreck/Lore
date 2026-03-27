# Correctness Fixes

Verified audit findings to fix. Each section is a self-contained bug with
location, root cause, and expected fix.

---

## 1. `listSymbols()` missing `ORDER BY` — nondeterministic pagination

**File:** `src/db/read-only.ts`  
**Function:** `listSymbols()` (the overloaded variant around line 362–388)

The query uses `LIMIT ? OFFSET ?` with **no `ORDER BY`** clause. Every other
listing function in the file (`listFiles`, `listSymbolRefs`, `listTypeRefs`,
`listAnnotations`, etc.) has a deterministic `ORDER BY`. Without one, paginated
callers get unpredictable results — rows can be skipped or duplicated between
pages if SQLite's internal order changes (e.g. after a `VACUUM` or concurrent
write).

**Current SQL (simplified):**

```sql
SELECT s.*, ...
  FROM effective_symbols s
  JOIN effective_files f ON s.file_id = f.id
  ...
  LIMIT ? OFFSET ?
```

**Fix:** Add an `ORDER BY` clause before `LIMIT ? OFFSET ?`. Match the pattern
used by `listSymbolRangesByName` which sorts on `f.path, f.branch, s.start_line, s.end_line, s.id`.

---

## 2. `dependents.ts` returns errors as data instead of throwing

**File:** `src/server/tools/dependents.ts`  
**Functions:** `handleFileDependents()` (~line 637), `handleSymbolDependents()`
(~line 676, ~line 682)

These functions return `{ error: "..." }` objects on failure (file not found,
symbol not found, ambiguous symbol). The `loggedHandler` wrapper in
`tool-registry.ts` catches **thrown** errors and formats them as MCP error
responses with proper logging. But these `return { error: ... }` calls bypass
that — they're serialized as successful JSON tool output with an unexpected
schema. MCP clients see a "success" containing `{"error":"..."}` instead of
a proper error response.

Every other tool (lookup, graph, trace, blame, etc.) throws on error
conditions. Only `dependents` returns error objects.

**Fix:** Replace the three `return { error: ... }` sites with `throw new Error(...)`:

1. `handleFileDependents`: `return { error: \`No file found...\` }` → throw
2. `handleSymbolDependents` (no matches): `return { error: \`No symbol found...\` }` → throw
3. `handleSymbolDependents` (ambiguous): `return { error: \`Ambiguous...\`, candidates }` → throw (include the candidates list in the error message)

After converting, the `DependentsErrorResult` type and the union return type on
both handler functions can be removed — they should return `DependentsResult`
only.

---

## 3. `FilePoller` stat failures silently skip files forever

**File:** `src/discovery/poller.ts`  
**Function:** `poll()` — the stat batch loop (~line 162–166)

```typescript
for (const { path: filePath, mtime } of stats) {
  currentPaths.add(filePath);   // Added to "seen" set even on stat failure
  if (mtime === null) continue; // Never indexed, never re-checked
  ...
}
```

If `stat()` fails (permission error, race with deletion), the file is added to
`currentPaths` (so it won't be treated as deleted) but skipped from change
detection. It stays in this state permanently — subsequent polls walk it again,
stat fails again, silently skipped again. The file is never indexed or flagged.

**Fix:** When `mtime === null`, do **not** add the file to `currentPaths`.
This way: (a) new files that can't be stat'd are ignored until they become
readable, and (b) previously-indexed files that become unreadable are detected
as deletions in the deletion sweep and trigger a removal update.

```typescript
for (const { path: filePath, mtime } of stats) {
  if (mtime === null) {
    // Don't add to currentPaths — let deletion sweep handle it if it was
    // previously indexed. New files that can't be stat'd are simply ignored.
    continue;
  }
  currentPaths.add(filePath);
  const prev = this.snapshot.get(filePath);
  if (prev === undefined || prev !== mtime) {
    changed.push(filePath);
    this.snapshot.set(filePath, mtime);
  }
}
```

---

## 4. `FileWatcher` uses string concatenation for path construction

**File:** `src/discovery/watcher.ts`  
**Function:** `start()` — the `fs.watch` callback (~line 139)

```typescript
const absPath = `${this.walkerConfig.rootDir}/${filename}`;
```

Should use `path.join()` for correct behavior when `rootDir` ends with `/`
(produces double slashes) and for cross-platform path separator handling.

**Fix:**

```typescript
const absPath = path.join(this.walkerConfig.rootDir, filename);
```

Verify that `path` is already imported (`import * as path from 'node:path'` or
similar); if not, add the import.

---

## 5. `blame.ts` git commands have no timeout

**File:** `src/server/tools/blame.ts`  
**Functions:** `runBlamePorcelain()` (~line 378), `runHistoryLog()` (~line 481)

Both spawn `git` child processes via `spawn()` with no timeout mechanism. On
corrupted repos or slow NFS mounts, these can hang indefinitely, blocking the
MCP server. All other external process spawns in the codebase (SCIP indexers,
LSP servers) have timeout or kill logic.

**Fix:** Add a timeout (e.g. 30 seconds) to both functions. On timeout, kill
the child and reject with a descriptive error:

```typescript
const BLAME_TIMEOUT_MS = 30_000;
const timer = setTimeout(() => {
  child.kill();
  reject(new Error(`git blame timed out after ${BLAME_TIMEOUT_MS}ms for ${relPath}`));
}, BLAME_TIMEOUT_MS);

child.on('close', () => { clearTimeout(timer); /* existing logic */ });
child.on('error', (err) => { clearTimeout(timer); reject(err); });
```

---

## 6. LSP `stdin.write()` has no error handling

**File:** `src/lsp/client.ts`  
**Functions:** `send()` (~line 200) and `sendResponse()` (~line 211)

Both write to the child process stdin without catching errors or checking the
return value. If the child exits between the `this.exited` guard check and the
`write()` call, an uncaught `EPIPE` error is thrown.

**Fix:** Wrap the `child.stdin.write()` call in a try-catch in both methods.
On write failure, mark the client as exited and reject pending requests:

```typescript
try {
  child.stdin.write(serialized, 'utf8');
} catch {
  this.exited = true;
  this.rejectPendingRequests(new Error('LSP stdin write failed — server exited'));
}
```

---

## 7. `ScipFlushManager` clears pending paths before flush completes

**File:** `src/discovery/scip-flush.ts`  
**Function:** `flush()` (~line 36)

```typescript
const paths = [...this.pathsSinceLastScip];
this.pathsSinceLastScip.clear();  // Cleared BEFORE baselineRebuild() completes
```

If `baselineRebuild()` fails, the paths are permanently lost. Files modified
during the rebuild window are added to the cleared set and may be lost too.

**Fix:** Move `this.pathsSinceLastScip.clear()` into a success-only path. On
failure, re-add the paths:

```typescript
const paths = [...this.pathsSinceLastScip];
this.pathsSinceLastScip.clear();
try {
  await builder.baselineRebuild();
} catch (err) {
  // Re-queue paths on failure so next flush retries them
  for (const p of paths) this.pathsSinceLastScip.add(p);
  throw err;
}
```

---

## 8. `installer.ts` uses shell interpolation for command check

**File:** `src/scip/installer.ts`  
**Function:** `defaultIsCommandAvailable()` (~line 52)

```typescript
childProcess.execSync(`which ${command}`, { stdio: 'ignore' });
```

`execSync` with string interpolation runs through a shell. Currently only
called with hardcoded spec commands so no injection today, but it's a latent
risk. Should use the array form.

**Fix:**

```typescript
childProcess.execFileSync('which', [command], { stdio: 'ignore' });
```

---

## 9. C/C++ include resolution uses string concat instead of `path.join()`

**File:** `src/resolution/resolver.ts`  
**Function:** `resolveC()` (~line 207–212)

```typescript
this.resolveRelative('./' + source, rootDir + '/fake', ['']);
```

`rootDir + '/fake'` should be `path.join(rootDir, 'fake')` for correct path
separator handling. The `'./' + source` prefix is acceptable since it's always
a POSIX-style include path.

**Fix:**

```typescript
this.resolveRelative('./' + source, path.join(rootDir, 'fake'), ['']);
```

---

## 10. Import resolver treats missing `package.json` as "all external"

**File:** `src/resolution/resolver.ts`  
**Function:** `resolveJavaScript()` — bare specifier handling (~line 103–107)

```typescript
if (pkgDeps.has(pkgName) || pkgDeps.size === 0) {
  return this.markExternal(source);
}
```

When `package.json` is absent or has no `dependencies`/`devDependencies`,
`pkgDeps.size === 0`, causing **all** bare imports to be classified as
external — including internal monorepo/workspace packages.

**Fix:** Only fall back to external when the package is explicitly listed, or
when `package.json` was successfully parsed and the name is not found:

```typescript
if (pkgDeps.has(pkgName)) {
  return this.markExternal(source);
}
```

Remove the `|| pkgDeps.size === 0` condition. When `package.json` is missing,
unrecognized bare specifiers should fall through to the existing final
`return this.markExternal(source)` at the end of the function, which already
handles this case identically — so the size-check is redundant and only
introduces the false-positive path for empty deps.

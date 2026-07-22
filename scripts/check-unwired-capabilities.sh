#!/usr/bin/env bash
# "No unwired capability" gate — the generator-level fix for the build-but-don't-wire disease.
#
# Every namespace+Static/Reactive capability module in src/modules MUST be referenced from at least one
# file OTHER than its own source and its own co-located *.test.ts. A capability referenced ONLY by its
# test is dead weight: it compiles, its isolated test is green, its contract reads as live — but nothing
# in the running app consumes it (GitWatcher, DiffView). Isolated tests HIDE this; this gate makes it a
# hard merge blocker.
#
# Forward-milestone modules (LSP = M5) are unwired BY DESIGN until their milestone lands;
# they are allowlisted WITH a justification. When M5 starts, wire + drive them (build the smoke first)
# and remove them from the allowlist.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Allowlisted capabilities, each unwired for a NAMED reason. This list only ever SHRINKS.
#  - LSP (M5): forward-milestone modules, built ahead, wired when its milestone lands.
#  (DiffView removed 2026-07-21 — now mounted via Workspace.diffRequest -> RootView syncDiffView; the
#   gate now enforces it stays wired.)
#  (Markdown removed 2026-07-22 — MarkdownSplitView mounts MarkdownPreview/Renderable from RootView,
#   and smoke-markdown drives the real tab-button path.)
ALLOWLIST_NAMES="JsonRpc LanguageClient LspProcess LspTransport TypeScriptProvider"

is_allowlisted() {
  local name="$1"
  for allowed in $ALLOWLIST_NAMES; do
    [ "$name" = "$allowed" ] && return 0
  done
  return 1
}

fail=0
unwired=""
allowed_hit=""

# Capability modules: a source file (not a test) whose namespace binds Class = Reactive($X) | Static($X).
while IFS= read -r file; do
  case "$file" in *.test.ts) continue ;; esac
  # The capability's public name = the namespace that owns the Reactive/Static Class binding.
  name="$(grep -oE "export namespace [A-Za-z0-9_]+" "$file" | awk '{print $3}' | head -1)"
  [ -n "$name" ] || continue

  testfile="${file%.ts}.test.ts"
  # A real CALL-SITE in a NON-test file that is not this module's own source = wired. We require a use
  # of the capability's runtime Class (`${name}.Class` — covers `new ${name}.Class(` and
  # `${name}.Class.method(`), NOT the bare identifier: an `import { ${name} }` line or a type-only
  # `${name}.Instance` annotation contains the identifier but consumes nothing at runtime, so
  # import-only-dead capabilities (the exact hole a human, not this gate, caught for TerminalSession)
  # would have passed. Requiring `.Class` closes that. (Its own test never counts.)
  refs="$(grep -rlE "\\b${name}\\.Class\\b" src --include="*.ts" 2>/dev/null \
    | grep -vxF "$file" \
    | grep -vxF "$testfile" \
    | grep -v "\.test\.ts$" || true)"

  if [ -z "$refs" ]; then
    if is_allowlisted "$name"; then
      allowed_hit="$allowed_hit\n  ALLOW  $name ($file) — forward-milestone, unwired by design"
    else
      unwired="$unwired\n  UNWIRED  $name ($file) — referenced only by itself/its test"
      fail=1
    fi
  fi
done < <(grep -rlE "Class = (Reactive|Static)\(" src/modules --include="*.ts")

if [ -n "$allowed_hit" ]; then
  echo "unwired-capabilities: allowlisted (forward-milestone):"
  printf '%b\n' "$allowed_hit"
fi

if [ "$fail" -ne 0 ]; then
  echo "unwired-capabilities: FAIL — capabilities built but never wired into the running app:"
  printf '%b\n' "$unwired"
  echo ""
  echo "  Wire each into a live caller path (and add a DRIVING test), or — if it is a forward-milestone"
  echo "  built ahead by design — add it to ALLOWLIST_NAMES in this script WITH a justification."
  exit 1
fi

echo "unwired-capabilities: PASS (every capability has a live caller)"
exit 0

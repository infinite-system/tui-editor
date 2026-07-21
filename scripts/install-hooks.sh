#!/usr/bin/env bash
# Install the repo's git hooks (they live in scripts/hooks/ so they are version-controlled; .git/hooks
# is not). Symlinks so edits to the tracked hook take effect without re-installing. Run once per clone.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_SOURCE_DIR="$REPO_ROOT/scripts/hooks"
GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"

for hook_path in "$HOOK_SOURCE_DIR"/*; do
  hook_name="$(basename "$hook_path")"
  chmod +x "$hook_path"
  ln -sf "../../scripts/hooks/$hook_name" "$GIT_HOOKS_DIR/$hook_name"
  echo "installed hook: $hook_name -> scripts/hooks/$hook_name"
done
echo "done. The full merge-gate now runs before every commit (SKIP_GATE=1 to bypass)."

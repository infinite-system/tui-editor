#!/usr/bin/env bash
# Driving smoke for the commit-log freshness + branch-viewer contracts:
#   1) "The commit log follows repository reality": an EXTERNAL commit (another terminal — no
#      in-app action, no working-tree event, HEAD file untouched) must appear in the HISTORY list
#      within the reconcile window, via the tip-SHA compare on the reconcile floor.
#   2) "The log branch viewer is read-only": 'b' / the header menu switches WHICH branch's history
#      the pane shows (same virtualized pipeline, ref-parameterized), the header labels the
#      non-checked-out view, commit drill-down works by SHA, Esc returns to HEAD — and the working
#      tree, index, and HEAD are byte-identical afterward (never a `git switch`).
#      The tip-SHA refresh also applies to the VIEWED ref (an external commit landing on the
#      viewed branch, made with plumbing so the worktree is untouched, appears without action).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
S="git-log-$$"
fail=0
f() { "$H" field "$S" "$1"; }
cap() { "$H" capture "$S"; }
GIT_ID=(-c user.email=a@b.c -c user.name=x)

pass() { echo "  PASS  $1"; }
failure() { echo "  FAIL  $1"; fail=1; }
expect_capture_contains() { # <needle> <label>
  if cap | grep -qF "$1"; then pass "$2"; else failure "$2 (pane missing '$1')"; fi
}
expect_capture_absent() { # <needle> <label>
  if cap | grep -qF "$1"; then failure "$2 (pane unexpectedly contains '$1')"; else pass "$2"; fi
}
wait_for_capture() { # <needle> <timeout-s> — poll the pane for text that arrives asynchronously
  local deadline=$(( SECONDS + $2 ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if cap | grep -qF "$1"; then return 0; fi
    sleep 0.4
  done
  return 1
}

echo "== fixture: main (3 commits) + feature (branched early, 2 own commits) =="
REPO="$(mktemp -d /tmp/tui-git-log.XXXXXX)"
( cd "$REPO" \
  && git init -q -b main \
  && printf 'base\n' > base.txt && git add -A && git "${GIT_ID[@]}" commit -qm 'root-subject-A' \
  && git branch feature \
  && printf 'main\n' > main.txt && git add -A && git "${GIT_ID[@]}" commit -qm 'main-only-B' \
  && git checkout -q feature \
  && printf 'feat1\n' > feat1.txt && git add -A && git "${GIT_ID[@]}" commit -qm 'feat-only-1' \
  && printf 'feat2 content line\n' > feat2.txt && git add -A && git "${GIT_ID[@]}" commit -qm 'feat-only-2' \
  && git checkout -q main )
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$REPO"' EXIT INT TERM

echo "== launch; git panel shows the checked-out branch's history (following HEAD) =="
"$H" launch "$S" 120x40 bun run src/main.ts "$REPO" >/dev/null
"$H" ready "$S" 20 >/dev/null || { echo "  FAIL boot"; exit 1; }
"$H" send "$S" C-g >/dev/null; sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
expect_capture_contains 'history: main' 'log header names the followed branch'
expect_capture_contains 'main-only-B' "main's own commit renders"
expect_capture_absent 'feat-only-2' "feature-only commits do not render on main"
[ "$(f gitLogBranch)" = "" ] && pass 'viewer follows HEAD (gitLogBranch empty)' \
  || failure "viewer not following HEAD (gitLogBranch='$(f gitLogBranch)')"

echo "== TASK 1: an EXTERNAL commit on the current branch appears WITHOUT any in-app action =="
git -C "$REPO" "${GIT_ID[@]}" commit -q --allow-empty -m 'ext-tip-C'
external_main_tip="$(git -C "$REPO" rev-parse HEAD)"
# No keys are sent: only the watcher's reconcile floor (5s) + tip-SHA compare may deliver this.
if wait_for_capture 'ext-tip-C' 12; then
  pass 'external commit reached the history pane within the reconcile window'
else
  failure 'history pane never gained the external commit (log-follows-reality broken)'
fi
"$H" settle "$S" >/dev/null 2>&1
[ "$(f gitLogTipSha)" = "$external_main_tip" ] && pass 'displayed tip SHA matches the real tip' \
  || failure "displayed tip '$(f gitLogTipSha)' != real tip '$external_main_tip'"

echo "== TASK 2: 'b' cycles the viewer to the feature branch (read-only view) =="
"$H" send "$S" b >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
[ "$(f gitLogBranch)" = "feature" ] && pass "viewer switched to 'feature'" \
  || failure "viewer on '$(f gitLogBranch)', expected 'feature'"
expect_capture_contains 'history: feature' 'header names the viewed branch'
expect_capture_contains 'view only' 'non-checked-out view is labeled read-only'
expect_capture_contains 'feat-only-2' "feature's own history renders"
expect_capture_absent 'main-only-B' "main-only commits do not render on the feature view"

echo "== watcher interplay: an external commit ON THE VIEWED branch (plumbing; worktree untouched) =="
feature_external_commit="$(git -C "$REPO" "${GIT_ID[@]}" commit-tree 'feature^{tree}' -p feature -m 'feat-ext-D')"
git -C "$REPO" update-ref refs/heads/feature "$feature_external_commit"
if wait_for_capture 'feat-ext-D' 12; then
  pass 'viewed-branch external commit reached the pane (tip probe follows the VIEWED ref)'
else
  failure 'viewed-branch external commit never appeared'
fi
"$H" settle "$S" >/dev/null 2>&1
[ "$(f gitLogTipSha)" = "$feature_external_commit" ] && pass 'viewed tip SHA tracks the viewed ref' \
  || failure "viewed tip '$(f gitLogTipSha)' != feature tip '$feature_external_commit'"

echo "== drill-down by SHA from the viewed branch: expand a commit, open its file diff =="
# Flat rows now: 0=feat-ext-D (empty), 1=feat-only-2. Select row 1 and expand it (lazy by-SHA fetch).
"$H" send "$S" Down >/dev/null; "$H" send "$S" Enter >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
[ "$(f gitLogExpanded)" = "1" ] && pass 'commit on the viewed branch expanded inline' \
  || failure "expansion count '$(f gitLogExpanded)', expected 1"
expect_capture_contains 'feat2.txt' "the expanded commit's changed file renders"
"$H" send "$S" Down >/dev/null; "$H" send "$S" Enter >/dev/null; sleep 1.0; "$H" settle "$S" >/dev/null 2>&1
[ "$(f showingDiff)" = "true" ] && pass 'file diff of a non-checked-out commit opened (routes by SHA)' \
  || failure "diff did not open from the viewed branch (showingDiff='$(f showingDiff)')"
expect_capture_contains 'feat2 content line' 'the diff shows the commit content (resolved by SHA)'

echo "== Esc returns the viewer to HEAD (after re-focusing the git panel) =="
"$H" send "$S" C-g >/dev/null; sleep 0.3   # diff moved focus to the editor; re-enter the panel
"$H" send "$S" Escape >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
[ "$(f gitLogBranch)" = "" ] && pass 'Esc returned the viewer to HEAD-following' \
  || failure "still viewing '$(f gitLogBranch)' after Esc"
expect_capture_contains 'history: main' 'header follows HEAD again'
if wait_for_capture 'ext-tip-C' 6; then pass "main's history renders again"; else failure "main's history did not return"; fi

echo "== mouse: clicking the header opens the branch menu; clicking a row selects it =="
header_line="$(cap | grep -nF 'history: main' | head -1 | cut -d: -f1)"
if [ -n "$header_line" ]; then
  "$H" click "$S" 8 "$((header_line - 1))" >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
  [ "$(f contextMenuOpen)" = "true" ] && pass 'header click opened the branch menu' \
    || failure "branch menu did not open (contextMenuOpen='$(f contextMenuOpen)')"
  expect_capture_contains 'main ✓' 'menu marks the checked-out branch'
  feature_item_line="$(cap | grep -n 'feature' | grep -v 'history:' | head -1 | cut -d: -f1)"
  if [ -n "$feature_item_line" ]; then
    "$H" click "$S" 12 "$((feature_item_line - 1))" >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
    [ "$(f gitLogBranch)" = "feature" ] && pass 'menu click re-sourced the viewer to feature' \
      || failure "menu click did not select feature (gitLogBranch='$(f gitLogBranch)')"
  else
    failure 'feature menu item not found in the pane'
  fi
  "$H" send "$S" Escape >/dev/null; sleep 0.5; "$H" settle "$S" >/dev/null 2>&1  # back to HEAD
else
  failure 'history header row not found for the mouse test'
fi

echo "== READ-ONLY GUARANTEE: the working tree, index, and HEAD never moved =="
current_branch="$(git -C "$REPO" branch --show-current)"
[ "$current_branch" = "main" ] && pass 'checked-out branch is still main (no git switch happened)' \
  || failure "checked-out branch changed to '$current_branch' — the viewer mutated HEAD"
status_output="$(git -C "$REPO" status --porcelain)"
[ -z "$status_output" ] && pass 'working tree + index are clean (untouched)' \
  || failure "working tree changed: $status_output"
final_head="$(git -C "$REPO" rev-parse HEAD)"
[ "$final_head" = "$external_main_tip" ] && pass 'HEAD SHA is byte-identical' \
  || failure "HEAD moved: $final_head != $external_main_tip"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"

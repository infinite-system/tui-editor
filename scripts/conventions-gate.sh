#!/usr/bin/env bash
# Mechanical convention checks — run at the SAME gate as tsc/tests/checker before every merge.
# Exit 1 on any violation. Legacy files awaiting the item-9 Static conversion are allowlisted;
# the list only ever SHRINKS.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1) NEW-FILE RULE: no bare exported function bags in modules (stateless behavior = Static class).
LEGACY_STATIC_ALLOWLIST="CommandRegistry.ts|theme.icons.ts|editor.coordinates.ts|scroll-momentum.ts|Highlighter.ts|commands.defaults.ts|keybindings.defaults.ts|keybindings.mac.ts|theme.palettes.ts|RootView.ts|Static.ts"
bare_bags=$(grep -rln "^export function" src/modules --include='*.ts' | grep -vE "\.test\.ts|__tests__|($LEGACY_STATIC_ALLOWLIST)$" || true)
if [ -n "$bare_bags" ]; then
  echo "CONVENTIONS FAIL: bare 'export function' bag(s) — new capability files are born namespace+Static:"
  echo "$bare_bags"
  fail=1
fi

# 2) Naming: banned abbreviation identifiers (declarations only; word-bounded).
abbreviations=$(grep -rnE "\b(const|let|var) (ed|ws|gp|cl|pal|idx|opts|prev|cur|repo|msg|cmd|btn|len)\b *=" src/modules --include='*.ts' | grep -v "__tests__" || true)
if [ -n "$abbreviations" ]; then
  echo "CONVENTIONS FAIL: abbreviated identifier declaration(s):"
  echo "$abbreviations"
  fail=1
fi

# 3) Keybindings: no inline chord conditionals outside the registry/defaults (key.name comparisons).
inline_chords=$(grep -rnE "key\.name === '[a-z0-9]+' && key\.(ctrl|super|option)" src/modules --include='*.ts' | grep -vE "keybindings/|__tests__" || true)
if [ -n "$inline_chords" ]; then
  echo "CONVENTIONS FAIL: inline chord conditional(s) — bindings are registry data:"
  echo "$inline_chords"
  fail=1
fi

# 4) tsc piping (masks exit codes) in scripts.
tsc_pipes=$(grep -rn "tsc --noEmit *|" scripts --include='*.sh' | grep -v "conventions-gate" || true)
if [ -n "$tsc_pipes" ]; then
  echo "CONVENTIONS FAIL: tsc piped (exit code masked):"
  echo "$tsc_pipes"
  fail=1
fi

[ "$fail" = 0 ] && echo "conventions-gate: PASS"
exit "$fail"

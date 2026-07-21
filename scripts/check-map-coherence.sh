#!/usr/bin/env bash
# Map-coherence gate — records are territory; governance and lattice maps must stay aligned with it.
#
# The root governance contract names the modules that require colocated invariant contracts. Materialized
# governed modules MUST carry that contract unless their bootstrap gap is explicitly allowlisted below.
# The project lattice is derived commentary, never legislative: every invariant identity it imports and
# every invariant name in its dependency map MUST resolve to a real ### record heading.
set -uo pipefail
REPOSITORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPOSITORY_ROOT"

GOVERNANCE_CONTRACT="project.invariants.md"
PROJECT_LATTICE="project.lattice.md"

# Allowlisted modules, each not yet bootstrapped for a NAMED, dated reason. This list only ever SHRINKS.
#  - kernel (2026-07-21): not yet bootstrapped; the M1 kernel contract remains pending.
#  - storage (2026-07-21): not yet bootstrapped; the M2 storage contract remains pending.
#  - syntax (2026-07-21): not yet bootstrapped; the M2 syntax contract remains pending.
#  - theme (2026-07-21): not yet bootstrapped; the M2 theme contract remains pending.
#  - commands (2026-07-21): not yet bootstrapped; the M7 commands contract remains pending.
ALLOWLIST_NAMES="kernel storage syntax theme commands"

is_allowlisted() {
  local module_name="$1"
  for allowed_module_name in $ALLOWLIST_NAMES; do
    [ "$module_name" = "$allowed_module_name" ] && return 0
  done
  return 1
}

failure_found=0
governance_findings=""
allowed_hit=""
allowlisted_module_count=0

governance_record="$(awk '
  $0 == "### Core modules are contract-governed" { inside_record = 1; next }
  inside_record && /^### / { exit }
  inside_record { print }
' "$GOVERNANCE_CONTRACT")"

if [ -z "$governance_record" ]; then
  governance_findings="$governance_findings\n  MISSING  Core modules are contract-governed ($GOVERNANCE_CONTRACT) — governance record not found"
  failure_found=1
else
  governed_module_names="$(printf '%s\n' "$governance_record" \
    | grep -E '^- M[0-9]+:' \
    | grep -oE '`[a-z][a-z0-9-]*`' \
    | tr -d '`' || true)"

  if [ -z "$governed_module_names" ]; then
    governance_findings="$governance_findings\n  EMPTY  Core modules are contract-governed ($GOVERNANCE_CONTRACT) — no milestone module names found"
    failure_found=1
  else
    declare -A governed_module_names_seen=()
    while IFS= read -r module_name; do
      [ -n "$module_name" ] || continue
      [ -z "${governed_module_names_seen[$module_name]+present}" ] || continue
      governed_module_names_seen["$module_name"]=1

      module_directory="src/modules/$module_name"
      # A directory containing only .gitkeep is a forward-milestone placeholder, not a materialized module.
      materialized_module_file="$(find "$module_directory" -type f ! -name '.gitkeep' -print -quit 2>/dev/null || true)"
      [ -n "$materialized_module_file" ] || continue

      contract_file="$module_directory/$module_name.invariants.md"
      [ ! -f "$contract_file" ] || continue

      if is_allowlisted "$module_name"; then
        allowed_hit="$allowed_hit\n  ALLOW  $module_name ($contract_file) — not yet bootstrapped (2026-07-21)"
        allowlisted_module_count=$((allowlisted_module_count + 1))
      else
        governance_findings="$governance_findings\n  MISSING  $module_name ($contract_file) — governed materialized module has no colocated contract"
        failure_found=1
      fi
    done <<< "$governed_module_names"
  fi
fi

mapfile -t module_contract_files < <(find src/modules -name '*.invariants.md' -type f | sort)
lattice_check_output="$(node - "$PROJECT_LATTICE" "$GOVERNANCE_CONTRACT" "${module_contract_files[@]}" 2>&1 <<'NODE'
const filesystem = require('node:fs')
const path = require('node:path')

const projectLatticePath = process.argv[2]
const contractPaths = process.argv.slice(3)
const projectLatticeText = filesystem.readFileSync(projectLatticePath, 'utf8').replace(/\r\n?/g, '\n')
const recordNames = new Set()
const recordsByContractPath = new Map()
const findings = []
const findingsSeen = new Set()
const resolvedRecordNames = new Set()

function addFinding(finding) {
  if (findingsSeen.has(finding)) return
  findingsSeen.add(finding)
  findings.push(finding)
}

function normalizeVisibleName(visibleName) {
  return visibleName.replace(/\s+/g, ' ').trim()
}

function recordSlug(recordName) {
  return recordName
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function contentOutsideFences(markdownText) {
  let insideFence = false
  return markdownText.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence
      return ''
    }
    return insideFence ? '' : line
  }).join('\n')
}

for (const contractPath of contractPaths) {
  const absoluteContractPath = path.resolve(contractPath)
  const contractText = contentOutsideFences(
    filesystem.readFileSync(contractPath, 'utf8').replace(/\r\n?/g, '\n'),
  )
  const recordsBySlug = new Map()
  const recordHeadingExpression = /^###\s+(.+?)\s*$/gm
  let recordHeadingMatch

  while ((recordHeadingMatch = recordHeadingExpression.exec(contractText)) !== null) {
    const recordName = normalizeVisibleName(recordHeadingMatch[1])
    recordNames.add(recordName)
    const normalizedRecordSlug = recordSlug(recordName)
    recordsBySlug.set(normalizedRecordSlug, recordName)
  }
  recordsByContractPath.set(absoluteContractPath, recordsBySlug)
}

function parseContractDestination(destination) {
  const destinationWithoutAngles = destination.replace(/^<|>$/g, '')
  const anchorSeparatorIndex = destinationWithoutAngles.lastIndexOf('#')
  if (anchorSeparatorIndex < 0) return undefined

  const targetPath = destinationWithoutAngles.slice(0, anchorSeparatorIndex)
  if (!targetPath.endsWith('.invariants.md')) return undefined

  const encodedAnchor = destinationWithoutAngles.slice(anchorSeparatorIndex + 1)
  let anchor
  try {
    anchor = decodeURIComponent(encodedAnchor)
  } catch {
    anchor = encodedAnchor
  }
  return { targetPath, anchor }
}

function resolveContractDestination(destination, referenceDescription) {
  const parsedDestination = parseContractDestination(destination)
  if (!parsedDestination) return undefined

  const absoluteTargetPath = path.resolve(path.dirname(projectLatticePath), parsedDestination.targetPath)
  const recordsBySlug = recordsByContractPath.get(absoluteTargetPath)
  if (!recordsBySlug) {
    addFinding(`  UNRESOLVED  ${referenceDescription} (${projectLatticePath}) — contract file ${parsedDestination.targetPath} does not exist`)
    return undefined
  }

  const recordName = recordsBySlug.get(parsedDestination.anchor)
  if (!recordName) {
    addFinding(`  UNRESOLVED  ${referenceDescription} (${projectLatticePath}) — no ### record for ${parsedDestination.targetPath}#${parsedDestination.anchor}`)
    return undefined
  }

  resolvedRecordNames.add(recordName)
  return recordName
}

const referenceDefinitions = new Map()
const referenceDefinitionExpression = /^\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+.*)?$/gm
let referenceDefinitionMatch
while ((referenceDefinitionMatch = referenceDefinitionExpression.exec(projectLatticeText)) !== null) {
  const referenceLabel = referenceDefinitionMatch[1]
  const destination = referenceDefinitionMatch[2] || referenceDefinitionMatch[3]
  referenceDefinitions.set(referenceLabel, destination)
  resolveContractDestination(destination, `[${referenceLabel}]`)
}

const referenceLinkExpression = /\[([^\]]+)\]\[([^\]]+)\]/g
let referenceLinkMatch
while ((referenceLinkMatch = referenceLinkExpression.exec(projectLatticeText)) !== null) {
  const visibleName = normalizeVisibleName(referenceLinkMatch[1])
  const referenceLabel = referenceLinkMatch[2]
  const destination = referenceDefinitions.get(referenceLabel)
  if (!destination) {
    addFinding(`  UNRESOLVED  ${visibleName} (${projectLatticePath}) — reference label [${referenceLabel}] has no definition`)
    continue
  }

  const resolvedRecordName = resolveContractDestination(destination, visibleName)
  if (resolvedRecordName && recordNames.has(visibleName) && visibleName !== resolvedRecordName) {
    addFinding(`  MISMATCH  ${visibleName} (${projectLatticePath}) — [${referenceLabel}] resolves to ${resolvedRecordName}`)
  }
}

const inlineContractLinkExpression = /\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g
let inlineContractLinkMatch
while ((inlineContractLinkMatch = inlineContractLinkExpression.exec(projectLatticeText)) !== null) {
  const visibleName = normalizeVisibleName(inlineContractLinkMatch[1])
  const destination = inlineContractLinkMatch[2] || inlineContractLinkMatch[3]
  const resolvedRecordName = resolveContractDestination(destination, visibleName)
  if (resolvedRecordName && recordNames.has(visibleName) && visibleName !== resolvedRecordName) {
    addFinding(`  MISMATCH  ${visibleName} (${projectLatticePath}) — inline link resolves to ${resolvedRecordName}`)
  }
}

function requireRecordName(recordName, referenceLocation) {
  if (recordNames.has(recordName)) {
    resolvedRecordNames.add(recordName)
    return
  }
  addFinding(`  UNRESOLVED  ${recordName} (${projectLatticePath} ${referenceLocation}) — no matching ### record in project or module contracts`)
}

const dependencyMapHeadingIndex = projectLatticeText.indexOf('## Dependency map')
if (dependencyMapHeadingIndex >= 0) {
  const dependencyMapFenceStart = projectLatticeText.indexOf('```', dependencyMapHeadingIndex)
  const dependencyMapFenceEnd = dependencyMapFenceStart < 0
    ? -1
    : projectLatticeText.indexOf('```', dependencyMapFenceStart + 3)

  if (dependencyMapFenceStart >= 0 && dependencyMapFenceEnd >= 0) {
    const dependencyMapText = projectLatticeText.slice(dependencyMapFenceStart + 3, dependencyMapFenceEnd)
    for (const dependencyMapLine of dependencyMapText.split('\n')) {
      for (const dependencyMapSegment of dependencyMapLine.split('►')) {
        const dependencyMapName = dependencyMapSegment
          .replace(/^[\s─│┌┐└┘├┤┬┴┼]+/, '')
          .replace(/[\s─│┌┐└┘├┤┬┴┼]+$/, '')
        if (!dependencyMapName || /^\((?:component|guards)(?:\)|\s)/.test(dependencyMapName)) continue
        requireRecordName(dependencyMapName, 'dependency map')
      }
    }
  }
}

if (findings.length > 0) {
  process.stdout.write(`${findings.join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(`${resolvedRecordNames.size}\n`)
NODE
)"
lattice_check_status=$?

if [ "$lattice_check_status" -ne 0 ]; then
  failure_found=1
fi

if [ -n "$allowed_hit" ]; then
  echo "map-coherence: allowlisted (not yet bootstrapped):"
  printf '%b\n' "$allowed_hit"
fi

if [ -n "$governance_findings" ]; then
  echo "map-coherence: FAIL — governed modules missing colocated contracts:"
  printf '%b\n' "$governance_findings"
fi

if [ "$lattice_check_status" -ne 0 ]; then
  echo "map-coherence: FAIL — lattice references records that do not exist:"
  printf '%s\n' "$lattice_check_output"
fi

if [ "$failure_found" -ne 0 ]; then
  echo ""
  echo "  Bootstrap each governed module contract (then remove its allowlist entry), and update the"
  echo "  derived lattice whenever its invariant record no longer exists. Records always win."
  exit 1
fi

echo "map-coherence: PASS ($allowlisted_module_count governed modules allowlisted; $lattice_check_output lattice records resolve)"
exit 0

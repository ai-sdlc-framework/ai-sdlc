#!/usr/bin/env bash
# check-resource-gate.sh — AISDLC-462
#
# Pre-spawn resource check for /ai-sdlc execute-parallel.
# Refuses if:
#   - Available memory (from vm_stat) < 4 GB
#   - System load average (1-min) >= number of CPU cores
#
# Exit 0 = system has headroom for another parallel session.
# Exit 1 = system is constrained; stderr explains why.
#
# Override: AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 to bypass (testing).

set -euo pipefail

if [ "${AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE:-}" = "1" ]; then
  echo "[resource-gate] skipped (AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1)" >&2
  exit 0
fi

# ─── Memory check ────────────────────────────────────────────────────────────
# vm_stat outputs lines like:
#   Pages free:                    123456.
#   Pages inactive:                789012.
#   Pages speculative:             34567.
#
# Available memory ≈ (free + inactive + speculative) × page_size (4096 bytes).
# We treat this as "available" — macOS can reclaim inactive pages on demand.

# Read the actual page size from the kernel (Apple Silicon M-series uses 16384,
# Intel Macs use 4096). Fall back to 4096 if sysctl is unavailable.
PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)

_parse_vm_stat_pages() {
  local label="$1"
  # vm_stat output varies slightly across macOS versions; use a permissive grep.
  printf '%s' "$VM_STAT_OUTPUT" \
    | grep -E "^${label}" \
    | grep -oE '[0-9]+' \
    | head -1 \
    || echo "0"
}

VM_STAT_OUTPUT=$(vm_stat 2>/dev/null) || {
  echo "[resource-gate] WARNING: vm_stat not available; skipping memory check" >&2
  VM_STAT_OUTPUT=""
}

if [ -n "$VM_STAT_OUTPUT" ]; then
  PAGES_FREE=$(_parse_vm_stat_pages "Pages free:")
  PAGES_INACTIVE=$(_parse_vm_stat_pages "Pages inactive:")
  PAGES_SPECULATIVE=$(_parse_vm_stat_pages "Pages speculative:")

  AVAIL_PAGES=$(( PAGES_FREE + PAGES_INACTIVE + PAGES_SPECULATIVE ))
  AVAIL_BYTES=$(( AVAIL_PAGES * PAGE_SIZE ))
  AVAIL_GB_INT=$(( AVAIL_BYTES / 1073741824 ))

  # Threshold: 4 GB = 4294967296 bytes
  THRESHOLD_BYTES=4294967296

  if [ "$AVAIL_BYTES" -lt "$THRESHOLD_BYTES" ]; then
    echo "[resource-gate] REFUSED: available memory ${AVAIL_GB_INT}GB < 4GB threshold" >&2
    echo "  Spawning another session now risks macOS memory pressure + swap thrash." >&2
    echo "  Wait for an existing session to complete, or set" >&2
    echo "  AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1 to override." >&2
    exit 1
  fi
  echo "[resource-gate] memory OK: ~${AVAIL_GB_INT}GB available" >&2
fi

# ─── Load average check ───────────────────────────────────────────────────────
# sysctl -n hw.ncpu returns the logical CPU count (e.g. 12).
# sysctl -n vm.loadavg returns e.g. "{ 2.15 3.42 4.10 }" (1-min, 5-min, 15-min).
# We compare 1-min load avg to ncpu as an integer comparison after flooring.

NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo "0")
LOADAVG_RAW=$(sysctl -n vm.loadavg 2>/dev/null || echo "{ 0.00 0.00 0.00 }")

# Extract the first number from the vm.loadavg output.
# The format is: "{ 2.15 3.42 4.10 }" — strip braces + spaces, take first token.
LOAD1=$(printf '%s' "$LOADAVG_RAW" | tr -d '{}' | awk '{print $1}' | sed 's/\..*//')

if [ -z "$LOAD1" ] || [ "$NCPU" -eq 0 ]; then
  echo "[resource-gate] WARNING: could not determine ncpu or load avg; skipping load check" >&2
else
  if [ "$LOAD1" -ge "$NCPU" ]; then
    echo "[resource-gate] REFUSED: 1-min load avg ${LOAD1} >= ncpu ${NCPU}" >&2
    echo "  CPU is saturated. Wait for running sessions to complete their review" >&2
    echo "  step (the heaviest subagent fan-out), then retry." >&2
    echo "  Override: AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE=1" >&2
    exit 1
  fi
  echo "[resource-gate] load OK: 1-min avg ${LOAD1} < ncpu ${NCPU}" >&2
fi

echo "[resource-gate] PASSED: system has headroom for another parallel session" >&2
exit 0

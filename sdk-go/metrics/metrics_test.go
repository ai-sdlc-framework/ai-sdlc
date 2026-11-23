package metrics

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMetricStore(t *testing.T) {
	store := NewMetricStore()

	err := store.Record("coverage", 85.0, map[string]string{"repo": "api"})
	require.NoError(t, err)

	val, ok := store.Get("coverage", map[string]string{"repo": "api"})
	assert.True(t, ok)
	assert.Equal(t, 85.0, val)

	_, ok = store.Get("coverage", map[string]string{"repo": "web"})
	assert.False(t, ok)

	names := store.List()
	assert.Contains(t, names, "coverage")
}

func TestInstrumentEnforcement(t *testing.T) {
	store := NewMetricStore()
	InstrumentEnforcement(store, "coverage-gate", true)
	InstrumentEnforcement(store, "coverage-gate", false)

	total, ok := store.Get("gate-evaluations-total", map[string]string{"gate": "coverage-gate"})
	assert.True(t, ok)
	assert.Equal(t, 2.0, total)

	passed, ok := store.Get("gate-evaluations-passed", map[string]string{"gate": "coverage-gate"})
	assert.True(t, ok)
	assert.Equal(t, 1.0, passed)
}

func TestStandardMetrics(t *testing.T) {
	expected := [][3]string{
		{"task-completion-rate", "task-effectiveness", "percent"},
		{"first-pass-success-rate", "task-effectiveness", "percent"},
		{"mean-time-to-completion", "task-effectiveness", "seconds"},
		{"approval-rate", "human-in-loop", "percent"},
		{"revision-count", "human-in-loop", "count"},
		{"human-intervention-rate", "human-in-loop", "percent"},
		{"test-coverage", "code-quality", "percent"},
		{"lint-pass-rate", "code-quality", "percent"},
		{"security-finding-rate", "code-quality", "per-kloc"},
		{"cost-per-task", "economic-efficiency", "usd"},
		{"time-saved-ratio", "economic-efficiency", "ratio"},
		{"autonomy-level", "autonomy-trajectory", "level"},
		{"promotion-velocity", "autonomy-trajectory", "levels-per-month"},
		{"demotion-frequency", "autonomy-trajectory", "per-month"},
		{"handoff-count", "task-effectiveness", "count"},
		{"handoff-failure-rate", "task-effectiveness", "percent"},
		{"approval-wait-time", "human-in-loop", "milliseconds"},
		{"sandbox-violation-count", "code-quality", "count"},
		{"kill-switch-activation-count", "autonomy-trajectory", "count"},
		{"compliance-coverage", "code-quality", "percent"},
		{"adapter-health-rate", "task-effectiveness", "percent"},
		{"agent-discovery-count", "task-effectiveness", "count"},
		{"total-cost-usd", "economic-efficiency", "usd"},
		{"total-input-tokens", "economic-efficiency", "count"},
		{"total-output-tokens", "economic-efficiency", "count"},
		{"cost-per-run", "economic-efficiency", "usd"},
		{"tokens-per-run", "economic-efficiency", "count"},
	}
	got := make([][3]string, 0, len(StandardMetrics))
	for _, m := range StandardMetrics {
		got = append(got, [3]string{m.Name, string(m.Category), m.Unit})
	}
	assert.ElementsMatch(t, expected, got)
}

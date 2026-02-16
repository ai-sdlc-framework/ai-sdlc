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
	assert.NotEmpty(t, StandardMetrics)
	for _, m := range StandardMetrics {
		assert.NotEmpty(t, m.Name)
		assert.NotEmpty(t, m.Category)
	}
}

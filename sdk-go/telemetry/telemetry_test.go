package telemetry

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSpanNames(t *testing.T) {
	assert.Equal(t, "ai-sdlc.evaluate_gate", SpanNames.EvaluateGate)
	assert.Equal(t, "ai-sdlc.reconcile", SpanNames.Reconcile)
}

func TestMetricNames(t *testing.T) {
	assert.Equal(t, "ai_sdlc.gate.evaluations", MetricNames.GateEvaluations)
}

func TestNoOpLogger(t *testing.T) {
	logger := NewNoOpLogger()
	logger.Debug("test", nil)
	logger.Info("test", nil)
	logger.Warn("test", nil)
	logger.Error("test", nil)
}

func TestBufferLogger(t *testing.T) {
	logger := NewBufferLogger()
	logger.Info("hello", map[string]interface{}{"key": "value"})
	logger.Error("oops", nil)

	assert.Len(t, logger.Entries, 2)
	assert.Equal(t, LogInfo, logger.Entries[0].Level)
	assert.Equal(t, "hello", logger.Entries[0].Message)
	assert.Equal(t, LogError, logger.Entries[1].Level)
}

func TestConsoleLogger(t *testing.T) {
	var buf bytes.Buffer
	logger := NewConsoleLoggerWithWriter(&buf)
	logger.Info("test message", map[string]interface{}{"x": 1})

	output := buf.String()
	assert.Contains(t, output, "test message")
	assert.Contains(t, output, "info")
}

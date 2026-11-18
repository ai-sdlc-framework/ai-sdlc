package telemetry

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/stretchr/testify/assert"
)

func structValues(v interface{}) []string {
	rv := reflect.ValueOf(v)
	out := make([]string, 0, rv.NumField())
	for i := 0; i < rv.NumField(); i++ {
		out = append(out, rv.Field(i).String())
	}
	return out
}

func TestSpanNames(t *testing.T) {
	assert.ElementsMatch(t, []string{
		"ai_sdlc.pipeline.stage",
		"ai_sdlc.agent.task",
		"ai_sdlc.gate.evaluation",
		"ai_sdlc.reconciliation.cycle",
		"ai_sdlc.handoff",
		"ai_sdlc.pipeline.run",
		"ai_sdlc.cost.tracking",
	}, structValues(SpanNames))
}

func TestMetricNames(t *testing.T) {
	assert.ElementsMatch(t, []string{
		"ai_sdlc.autonomy.level",
		"ai_sdlc.gate.pass.total",
		"ai_sdlc.gate.fail.total",
		"ai_sdlc.task.duration_ms",
		"ai_sdlc.reconciliation.duration_ms",
		"ai_sdlc.task.success.total",
		"ai_sdlc.task.failure.total",
		"ai_sdlc.autonomy.promotion.total",
		"ai_sdlc.autonomy.demotion.total",
		"ai_sdlc.handoff.total",
		"ai_sdlc.handoff.failure.total",
		"ai_sdlc.approval.wait_ms",
		"ai_sdlc.sandbox.violation.total",
		"ai_sdlc.killswitch.activation.total",
		"ai_sdlc.compliance.coverage_percent",
		"ai_sdlc.adapter.health.total",
		"ai_sdlc.agent.discovery.total",
		"ai_sdlc.admission.duration_ms",
		"ai_sdlc.llm_eval.duration_ms",
		"ai_sdlc.llm_eval.score",
		"ai_sdlc.expression_eval.duration_ms",
		"ai_sdlc.cost.usd.total",
		"ai_sdlc.tokens.input.total",
		"ai_sdlc.tokens.output.total",
		"ai_sdlc.tokens.total",
		"ai_sdlc.cost.per_task_usd",
	}, structValues(MetricNames))
}

func TestAttributeKeys(t *testing.T) {
	assert.ElementsMatch(t, []string{
		"ai_sdlc.pipeline",
		"ai_sdlc.stage",
		"ai_sdlc.agent",
		"ai_sdlc.gate",
		"ai_sdlc.enforcement",
		"ai_sdlc.result",
		"ai_sdlc.resource.kind",
		"ai_sdlc.resource.name",
		"ai_sdlc.model",
		"ai_sdlc.cost_usd",
		"ai_sdlc.tokens",
		"ai_sdlc.complexity_band",
		"ai_sdlc.run_id",
	}, structValues(AttributeKeys))
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

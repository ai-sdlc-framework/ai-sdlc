package core

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPipelineImplementsAnyResource(t *testing.T) {
	p := &Pipeline{
		APIVersion: APIVersion,
		Kind:       "Pipeline",
		Metadata:   Metadata{Name: "test"},
	}
	var r AnyResource = p
	assert.Equal(t, KindPipeline, r.GetKind())
	assert.Equal(t, "test", r.GetMetadata().Name)
}

func TestAgentRoleImplementsAnyResource(t *testing.T) {
	a := &AgentRole{
		APIVersion: APIVersion,
		Kind:       "AgentRole",
		Metadata:   Metadata{Name: "coder"},
	}
	var r AnyResource = a
	assert.Equal(t, KindAgentRole, r.GetKind())
	assert.Equal(t, "coder", r.GetMetadata().Name)
}

func TestQualityGateImplementsAnyResource(t *testing.T) {
	q := &QualityGate{
		APIVersion: APIVersion,
		Kind:       "QualityGate",
		Metadata:   Metadata{Name: "gate"},
	}
	var r AnyResource = q
	assert.Equal(t, KindQualityGate, r.GetKind())
}

func TestAutonomyPolicyImplementsAnyResource(t *testing.T) {
	a := &AutonomyPolicy{
		APIVersion: APIVersion,
		Kind:       "AutonomyPolicy",
		Metadata:   Metadata{Name: "policy"},
	}
	var r AnyResource = a
	assert.Equal(t, KindAutonomyPolicy, r.GetKind())
}

func TestAdapterBindingImplementsAnyResource(t *testing.T) {
	a := &AdapterBinding{
		APIVersion: APIVersion,
		Kind:       "AdapterBinding",
		Metadata:   Metadata{Name: "binding"},
	}
	var r AnyResource = a
	assert.Equal(t, KindAdapterBinding, r.GetKind())
}

func TestUnmarshalResource(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		wantKind ResourceKind
		wantName string
	}{
		{
			name:     "pipeline",
			json:     `{"apiVersion":"ai-sdlc.io/v1alpha1","kind":"Pipeline","metadata":{"name":"p1"},"spec":{"triggers":[],"providers":{},"stages":[]}}`,
			wantKind: KindPipeline,
			wantName: "p1",
		},
		{
			name:     "agent role",
			json:     `{"apiVersion":"ai-sdlc.io/v1alpha1","kind":"AgentRole","metadata":{"name":"a1"},"spec":{"role":"dev","goal":"code","tools":["git"]}}`,
			wantKind: KindAgentRole,
			wantName: "a1",
		},
		{
			name:     "quality gate",
			json:     `{"apiVersion":"ai-sdlc.io/v1alpha1","kind":"QualityGate","metadata":{"name":"qg1"},"spec":{"gates":[]}}`,
			wantKind: KindQualityGate,
			wantName: "qg1",
		},
		{
			name:     "autonomy policy",
			json:     `{"apiVersion":"ai-sdlc.io/v1alpha1","kind":"AutonomyPolicy","metadata":{"name":"ap1"},"spec":{"levels":[],"promotionCriteria":{},"demotionTriggers":[]}}`,
			wantKind: KindAutonomyPolicy,
			wantName: "ap1",
		},
		{
			name:     "adapter binding",
			json:     `{"apiVersion":"ai-sdlc.io/v1alpha1","kind":"AdapterBinding","metadata":{"name":"ab1"},"spec":{"interface":"IssueTracker","type":"linear","version":"1.0.0"}}`,
			wantKind: KindAdapterBinding,
			wantName: "ab1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := UnmarshalResource([]byte(tt.json))
			require.NoError(t, err)
			assert.Equal(t, tt.wantKind, r.GetKind())
			assert.Equal(t, tt.wantName, r.GetMetadata().Name)
		})
	}
}

func TestUnmarshalResourceUnknownKind(t *testing.T) {
	_, err := UnmarshalResource([]byte(`{"kind":"Bogus"}`))
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unknown resource kind")
}

func TestPipelineJSONRoundTrip(t *testing.T) {
	p := Pipeline{
		APIVersion: APIVersion,
		Kind:       "Pipeline",
		Metadata:   Metadata{Name: "my-pipeline", Labels: map[string]string{"env": "prod"}},
		Spec: PipelineSpec{
			Triggers:  []Trigger{{Event: "issue.assigned"}},
			Providers: map[string]Provider{"issueTracker": {Type: "linear"}},
			Stages:    []Stage{{Name: "plan", Agent: "planner"}},
		},
	}

	data, err := json.Marshal(p)
	require.NoError(t, err)

	var p2 Pipeline
	require.NoError(t, json.Unmarshal(data, &p2))
	assert.Equal(t, p.Metadata.Name, p2.Metadata.Name)
	assert.Equal(t, p.Spec.Triggers[0].Event, p2.Spec.Triggers[0].Event)
	assert.Equal(t, p.Spec.Stages[0].Agent, p2.Spec.Stages[0].Agent)
}

func TestGateRuleType(t *testing.T) {
	threshold := 80.0
	tests := []struct {
		name string
		rule GateRule
		want string
	}{
		{"metric", GateRule{Metric: "coverage", Operator: ">=", Threshold: &threshold}, "metric"},
		{"tool", GateRule{Tool: "semgrep"}, "tool"},
		{"reviewer", GateRule{MinimumReviewers: intPtr(2)}, "reviewer"},
		{"documentation", GateRule{ChangedFilesRequireDocUpdate: boolPtr(true)}, "documentation"},
		{"provenance", GateRule{RequireAttribution: boolPtr(true)}, "provenance"},
		{"expression", GateRule{Expression: "metrics.coverage > 80"}, "expression"},
		{"llm", GateRule{Prompt: "review this code"}, "llm"},
		{"unknown", GateRule{}, "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, tt.rule.RuleType())
		})
	}
}

func intPtr(i int) *int       { return &i }
func boolPtr(b bool) *bool    { return &b }

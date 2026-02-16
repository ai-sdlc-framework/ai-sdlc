package builders

import (
	"testing"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPipelineBuilder(t *testing.T) {
	p, err := NewPipelineBuilder("test-pipeline").
		Namespace("team-a").
		Label("env", "staging").
		AddTrigger("issue.assigned", nil).
		AddProvider("issueTracker", "linear", nil).
		AddStage("plan", "planner", nil).
		AddStage("code", "coder", &StageOptions{
			QualityGates: []string{"code-quality"},
			Timeout:      "PT30M",
		}).
		WithRouting(&core.RoutingConfig{
			ComplexityThresholds: map[string]core.ComplexityThreshold{
				"simple": {Min: 1, Max: 3, Strategy: "fully-autonomous"},
			},
		}).
		Build()

	require.NoError(t, err)
	assert.Equal(t, "test-pipeline", p.Metadata.Name)
	assert.Equal(t, "team-a", p.Metadata.Namespace)
	assert.Equal(t, core.APIVersion, p.APIVersion)
	assert.Equal(t, "Pipeline", p.Kind)
	assert.Len(t, p.Spec.Triggers, 1)
	assert.Len(t, p.Spec.Stages, 2)
	assert.Equal(t, "planner", p.Spec.Stages[0].Agent)
	assert.Equal(t, "staging", p.Metadata.Labels["env"])
	assert.NotNil(t, p.Spec.Routing)
}

func TestPipelineBuilderValidation(t *testing.T) {
	_, err := NewPipelineBuilder("").Build()
	assert.Error(t, err)

	_, err = NewPipelineBuilder("p").Build()
	assert.Error(t, err, "should fail without triggers")

	_, err = NewPipelineBuilder("p").AddTrigger("x", nil).Build()
	assert.Error(t, err, "should fail without stages")
}

func TestAgentRoleBuilder(t *testing.T) {
	a, err := NewAgentRoleBuilder("coder-agent").
		Role("Senior Software Engineer").
		Goal("Write clean code").
		Backstory("Expert in Go and Python").
		AddTool("git").
		AddTool("vscode").
		WithConstraints(&core.Constraints{RequireTests: boolPtr(true)}).
		AddHandoff("reviewer", "code-complete", nil).
		AddSkill("go-development", "Expert Go development", []string{"go", "backend"}).
		Build()

	require.NoError(t, err)
	assert.Equal(t, "coder-agent", a.Metadata.Name)
	assert.Equal(t, "Senior Software Engineer", a.Spec.Role)
	assert.Len(t, a.Spec.Tools, 2)
	assert.Len(t, a.Spec.Handoffs, 1)
	assert.Len(t, a.Spec.Skills, 1)
}

func TestAgentRoleBuilderValidation(t *testing.T) {
	_, err := NewAgentRoleBuilder("a").Goal("g").AddTool("t").Build()
	assert.Error(t, err, "should fail without role")

	_, err = NewAgentRoleBuilder("a").Role("r").AddTool("t").Build()
	assert.Error(t, err, "should fail without goal")

	_, err = NewAgentRoleBuilder("a").Role("r").Goal("g").Build()
	assert.Error(t, err, "should fail without tools")
}

func TestQualityGateBuilder(t *testing.T) {
	threshold := 80.0
	q, err := NewQualityGateBuilder("code-quality").
		WithScope(&core.GateScope{AuthorTypes: []string{"ai-agent"}}).
		AddGate("coverage", core.EnforcementHardMandatory,
			core.GateRule{Metric: "coverage", Operator: ">=", Threshold: &threshold}, nil).
		Build()

	require.NoError(t, err)
	assert.Equal(t, "code-quality", q.Metadata.Name)
	assert.Len(t, q.Spec.Gates, 1)
	assert.NotNil(t, q.Spec.Scope)
}

func TestAutonomyPolicyBuilder(t *testing.T) {
	a, err := NewAutonomyPolicyBuilder("progressive").
		AddLevel(core.AutonomyLevel{
			Level:       0,
			Name:        "Intern",
			Permissions: core.Permissions{Read: []string{"*"}, Write: []string{"draft-pr"}, Execute: []string{"test"}},
			Guardrails:  core.Guardrails{RequireApproval: core.ApprovalAll},
			Monitoring:  core.MonitoringContinuous,
		}).
		AddPromotionCriteria("0-to-1", core.PromotionCriteria{
			MinimumTasks:      10,
			Conditions:        []core.MetricCondition{{Metric: "approval-rate", Operator: ">=", Threshold: 0.9}},
			RequiredApprovals: []string{"tech-lead"},
		}).
		AddDemotionTrigger(core.DemotionTrigger{
			Trigger: "security-violation", Action: core.DemoteToZero, Cooldown: "7d",
		}).
		Build()

	require.NoError(t, err)
	assert.Equal(t, "progressive", a.Metadata.Name)
	assert.Len(t, a.Spec.Levels, 1)
}

func TestAdapterBindingBuilder(t *testing.T) {
	a, err := NewAdapterBindingBuilder("linear-binding").
		Interface(core.InterfaceIssueTracker).
		Type("linear").
		Version("1.0.0").
		Source("registry://adapters/linear").
		Config(map[string]interface{}{"apiUrl": "https://api.linear.app"}).
		WithHealthCheck(&core.HealthCheck{Interval: "30s", Timeout: "5s"}).
		Build()

	require.NoError(t, err)
	assert.Equal(t, "linear-binding", a.Metadata.Name)
	assert.Equal(t, core.InterfaceIssueTracker, a.Spec.Interface)
	assert.NotNil(t, a.Spec.HealthCheck)
}

func TestAdapterBindingBuilderValidation(t *testing.T) {
	_, err := NewAdapterBindingBuilder("a").Type("t").Version("1.0.0").Build()
	assert.Error(t, err, "should fail without interface")
}

func TestDistributionManifest(t *testing.T) {
	m, err := BuildDistribution("my-dist", "1.0.0", []ManifestEntry{
		{Path: "pipeline.yaml", Kind: "Pipeline", Name: "my-pipeline"},
	})
	require.NoError(t, err)
	assert.Equal(t, "my-dist", m.Metadata.Name)
	assert.Len(t, m.Resources, 1)
}

func TestParseManifestYAML(t *testing.T) {
	yaml := `
apiVersion: ai-sdlc.io/v1alpha1
kind: Distribution
metadata:
  name: test-dist
resources:
  - path: pipeline.yaml
    kind: Pipeline
    name: my-pipeline
`
	m, err := ParseBuilderManifest([]byte(yaml))
	require.NoError(t, err)
	assert.Equal(t, "test-dist", m.Metadata.Name)
}

func boolPtr(b bool) *bool { return &b }

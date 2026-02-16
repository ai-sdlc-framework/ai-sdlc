package policy

import (
	"context"
	"testing"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func float64Ptr(f float64) *float64 { return &f }
func intPtr(i int) *int             { return &i }
func boolPtr(b bool) *bool          { return &b }

func TestEvaluateGateMetric(t *testing.T) {
	gate := core.Gate{
		Name:        "coverage",
		Enforcement: core.EnforcementHardMandatory,
		Rule:        core.GateRule{Metric: "coverage", Operator: ">=", Threshold: float64Ptr(80)},
	}

	ctx := context.Background()
	result := EvaluateGate(ctx, gate, &EvaluationContext{Metrics: map[string]float64{"coverage": 85}})
	assert.True(t, result.Passed)

	result = EvaluateGate(ctx, gate, &EvaluationContext{Metrics: map[string]float64{"coverage": 75}})
	assert.False(t, result.Passed)
}

func TestEvaluateGateReviewer(t *testing.T) {
	gate := core.Gate{
		Name:        "review",
		Enforcement: core.EnforcementSoftMandatory,
		Rule:        core.GateRule{MinimumReviewers: intPtr(2), AIAuthorRequiresExtraReviewer: boolPtr(true)},
	}

	ctx := context.Background()
	result := EvaluateGate(ctx, gate, &EvaluationContext{ReviewerCount: 3, AIAuthored: true})
	assert.True(t, result.Passed)

	result = EvaluateGate(ctx, gate, &EvaluationContext{ReviewerCount: 2, AIAuthored: true})
	assert.False(t, result.Passed, "AI authored requires extra reviewer")
}

func TestEnforce(t *testing.T) {
	qg := &core.QualityGate{
		APIVersion: core.APIVersion,
		Kind:       "QualityGate",
		Metadata:   core.Metadata{Name: "test"},
		Spec: core.QualityGateSpec{
			Gates: []core.Gate{
				{Name: "coverage", Enforcement: core.EnforcementHardMandatory,
					Rule: core.GateRule{Metric: "coverage", Operator: ">=", Threshold: float64Ptr(80)}},
				{Name: "docs", Enforcement: core.EnforcementAdvisory,
					Rule: core.GateRule{ChangedFilesRequireDocUpdate: boolPtr(true)}},
			},
		},
	}

	ctx := context.Background()
	result := Enforce(ctx, qg, &EvaluationContext{
		Metrics:          map[string]float64{"coverage": 85},
		DocUpdatePresent: false,
	})
	assert.True(t, result.Passed, "advisory gate failure should not block")
	assert.Len(t, result.Results, 2)
}

func TestEvaluatePromotion(t *testing.T) {
	policy := &core.AutonomyPolicy{
		Spec: core.AutonomyPolicySpec{
			PromotionCriteria: map[string]core.PromotionCriteria{
				"0-to-1": {
					MinimumTasks:      10,
					Conditions:        []core.MetricCondition{{Metric: "approval-rate", Operator: ">=", Threshold: 0.9}},
					RequiredApprovals: []string{"tech-lead"},
				},
			},
		},
	}

	result := EvaluatePromotion(policy, 0, &AgentMetrics{
		TasksCompleted: 15,
		Metrics:        map[string]float64{"approval-rate": 0.95},
		Approvals:      []string{"tech-lead"},
	})
	assert.True(t, result.Eligible)
	assert.Equal(t, 1, result.ToLevel)
}

func TestEvaluatePromotionIneligible(t *testing.T) {
	policy := &core.AutonomyPolicy{
		Spec: core.AutonomyPolicySpec{
			PromotionCriteria: map[string]core.PromotionCriteria{
				"0-to-1": {
					MinimumTasks:      10,
					Conditions:        []core.MetricCondition{{Metric: "approval-rate", Operator: ">=", Threshold: 0.9}},
					RequiredApprovals: []string{"tech-lead"},
				},
			},
		},
	}

	result := EvaluatePromotion(policy, 0, &AgentMetrics{
		TasksCompleted: 5,
		Metrics:        map[string]float64{"approval-rate": 0.8},
		Approvals:      []string{},
	})
	assert.False(t, result.Eligible)
	assert.NotEmpty(t, result.Reasons)
}

func TestEvaluateDemotion(t *testing.T) {
	policy := &core.AutonomyPolicy{
		Spec: core.AutonomyPolicySpec{
			DemotionTriggers: []core.DemotionTrigger{
				{Trigger: "security-violation", Action: core.DemoteToZero, Cooldown: "7d"},
			},
		},
	}

	result := EvaluateDemotion(policy, 2, "security-violation")
	assert.True(t, result.Demoted)
	assert.Equal(t, 0, result.ToLevel)

	result = EvaluateDemotion(policy, 2, "minor-issue")
	assert.False(t, result.Demoted)
}

func TestScoreComplexity(t *testing.T) {
	// Low complexity: 2 files, 15 lines → score 1-3
	score := ScoreComplexity(&ComplexityInput{FilesAffected: 2, LinesOfChange: 15})
	assert.GreaterOrEqual(t, score, 1)
	assert.LessOrEqual(t, score, 3)

	// High complexity: many files, many lines, all flags → score 8-10
	score = ScoreComplexity(&ComplexityInput{
		FilesAffected:      50,
		LinesOfChange:      2000,
		SecuritySensitive:  true,
		APIChange:          true,
		DatabaseMigration:  true,
		CrossServiceChange: true,
	})
	assert.GreaterOrEqual(t, score, 8)
	assert.LessOrEqual(t, score, 10)

	custom := 7
	score = ScoreComplexity(&ComplexityInput{CustomScore: &custom})
	assert.Equal(t, 7, score)
}

func TestRouteByComplexity(t *testing.T) {
	routing := &core.RoutingConfig{
		ComplexityThresholds: map[string]core.ComplexityThreshold{
			"simple":  {Min: 1, Max: 3, Strategy: "fully-autonomous"},
			"medium":  {Min: 4, Max: 7, Strategy: "ai-with-review"},
			"complex": {Min: 8, Max: 10, Strategy: "human-led"},
		},
	}

	result := RouteByComplexity(routing, 2)
	assert.Equal(t, "simple", result.Tier)
	assert.Equal(t, "fully-autonomous", result.Strategy)

	result = RouteByComplexity(routing, 9)
	assert.Equal(t, "complex", result.Tier)
}

func TestAuthorize(t *testing.T) {
	ctx := context.Background()
	allow := func(ctx context.Context, ac *AuthorizationContext) (*AuthorizationResult, error) {
		return &AuthorizationResult{Allowed: true}, nil
	}
	deny := func(ctx context.Context, ac *AuthorizationContext) (*AuthorizationResult, error) {
		return &AuthorizationResult{Allowed: false, Reason: "denied"}, nil
	}

	result, err := Authorize(ctx, &AuthorizationContext{Subject: "user"}, allow)
	require.NoError(t, err)
	assert.True(t, result.Allowed)

	result, err = Authorize(ctx, &AuthorizationContext{Subject: "user"}, allow, deny)
	require.NoError(t, err)
	assert.False(t, result.Allowed)
}

func TestTokenAuthenticator(t *testing.T) {
	auth := NewTokenAuthenticator(map[string]*AuthIdentity{
		"valid-token": {Subject: "alice", Roles: []string{"admin"}},
	})

	ctx := context.Background()
	id, err := auth.Authenticate(ctx, "valid-token")
	require.NoError(t, err)
	assert.Equal(t, "alice", id.Subject)

	_, err = auth.Authenticate(ctx, "bad-token")
	assert.Error(t, err)
}

func TestSimpleExpressionEvaluator(t *testing.T) {
	eval := NewSimpleExpressionEvaluator()
	vars := map[string]interface{}{
		"metrics": map[string]interface{}{"coverage": float64(85)},
	}

	result, err := eval.Evaluate("metrics.coverage >= 80", vars)
	require.NoError(t, err)
	assert.True(t, result)

	result, err = eval.Evaluate("metrics.coverage < 80", vars)
	require.NoError(t, err)
	assert.False(t, result)
}

func TestMutatingGate(t *testing.T) {
	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       "Pipeline",
		Metadata:   core.Metadata{Name: "test"},
	}

	injector := NewLabelInjector(map[string]string{"env": "prod"})
	enricher := NewMetadataEnricher(map[string]string{"version": "1.0"})

	err := ApplyMutatingGates(p, injector, enricher)
	require.NoError(t, err)
	assert.Equal(t, "prod", p.Metadata.Labels["env"])
	assert.Equal(t, "1.0", p.Metadata.Annotations["version"])
}

func TestABACAuthorizationHook(t *testing.T) {
	policy := &ABACPolicy{
		Rules: []ABACRule{
			{Subject: "admin", Action: "*", Resource: "*", Effect: "allow"},
			{Subject: "user", Action: "read", Resource: "*", Effect: "allow"},
			{Subject: "user", Action: "write", Resource: "Pipeline", Effect: "deny"},
		},
	}

	hook := NewABACAuthorizationHook(policy)
	ctx := context.Background()

	result, err := hook(ctx, &AuthorizationContext{Subject: "admin", Action: "write", Resource: "Pipeline"})
	require.NoError(t, err)
	assert.True(t, result.Allowed)

	result, err = hook(ctx, &AuthorizationContext{Subject: "user", Action: "write", Resource: "Pipeline"})
	require.NoError(t, err)
	assert.False(t, result.Allowed)
}

func TestAdmissionPipeline(t *testing.T) {
	pipeline := NewAdmissionPipeline().
		WithAuthorizationHooks(func(ctx context.Context, ac *AuthorizationContext) (*AuthorizationResult, error) {
			return &AuthorizationResult{Allowed: true}, nil
		}).
		WithMutatingGates(NewLabelInjector(map[string]string{"admitted": "true"}))

	p := &core.Pipeline{
		APIVersion: core.APIVersion,
		Kind:       "Pipeline",
		Metadata:   core.Metadata{Name: "test"},
	}

	resp := pipeline.AdmitResource(context.Background(), &AdmissionRequest{
		Resource:  p,
		Identity:  &AuthIdentity{Subject: "alice"},
		Operation: "create",
	})
	assert.True(t, resp.Allowed)
	assert.Equal(t, "true", p.Metadata.Labels["admitted"])
}

func TestLLMEvaluator(t *testing.T) {
	stub := NewStubLLMEvaluator(true, "PASS")
	rule := &core.GateRule{Prompt: "review this", LLMModel: "gpt-4", PassPhrase: "PASS"}
	result := EvaluateLLMRule(context.Background(), rule, stub, nil)
	assert.True(t, result.Passed)
}

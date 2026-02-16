package aisdlc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/agents"
	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/policy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

const fixtureDir = "../conformance/tests/v1alpha1"

// ── Schema Conformance Tests ──────────────────────────────────────

func TestConformanceSchemaValidation(t *testing.T) {
	categories := []string{"pipeline", "agent-role", "quality-gate", "autonomy-policy", "adapter"}
	for _, cat := range categories {
		dir := filepath.Join(fixtureDir, cat)
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Skipf("skipping %s: %v", cat, err)
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
				continue
			}
			name := entry.Name()
			expectValid := strings.HasPrefix(name, "valid-")
			t.Run(fmt.Sprintf("%s/%s", cat, name), func(t *testing.T) {
				data, err := os.ReadFile(filepath.Join(dir, name))
				require.NoError(t, err)

				// Parse YAML to generic map, round-trip through JSON to normalize types
				var raw map[string]interface{}
				err = yaml.Unmarshal(data, &raw)
				require.NoError(t, err)

				jsonData, err := json.Marshal(raw)
				require.NoError(t, err)

				// Re-unmarshal from JSON to get json-compatible types (float64 for numbers, etc.)
				var normalized interface{}
				err = json.Unmarshal(jsonData, &normalized)
				require.NoError(t, err)

				kind, _ := raw["kind"].(string)
				result := core.Validate(core.ResourceKind(kind), normalized)

				if expectValid {
					assert.True(t, result.Valid,
						"expected %s to be valid but got errors: %v", name, result.Errors)
				} else {
					assert.False(t, result.Valid,
						"expected %s to be invalid but it passed validation", name)
				}
			})
		}
	}
}

// ── Behavioral Conformance Tests ──────────────────────────────────

// behavioralTest is the YAML structure for behavioral test fixtures.
type behavioralTest struct {
	Kind        string `yaml:"kind"`
	APIVersion  string `yaml:"apiVersion"`
	Description string `yaml:"description"`
	Metadata    struct {
		ConformanceLevel string `yaml:"conformanceLevel"`
	} `yaml:"metadata"`
	Test struct {
		Type     string                 `yaml:"type"`
		Input    map[string]interface{} `yaml:"input"`
		Expected map[string]interface{} `yaml:"expected"`
	} `yaml:"test"`
}

func TestConformanceBehavioral(t *testing.T) {
	dir := filepath.Join(fixtureDir, "behavioral")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("skipping behavioral: %v", err)
		return
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".yaml") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			require.NoError(t, err)

			var bt behavioralTest
			err = yaml.Unmarshal(data, &bt)
			require.NoError(t, err)
			require.Equal(t, "BehavioralTest", bt.Kind)

			switch bt.Test.Type {
			case "quality-gate-evaluation":
				runQualityGateTest(t, bt)
			case "autonomy-promotion":
				runAutonomyPromotionTest(t, bt)
			case "autonomy-demotion":
				runAutonomyDemotionTest(t, bt)
			case "complexity-routing":
				runComplexityRoutingTest(t, bt)
			case "handoff-validation":
				runHandoffValidationTest(t, bt)
			case "orchestration-error":
				runOrchestrationErrorTest(t, bt)
			case "pipeline-failure-policy":
				runPipelineFailurePolicyTest(t, bt)
			default:
				t.Skipf("unknown behavioral test type: %s", bt.Test.Type)
			}
		})
	}
}

// ── Quality Gate Evaluation Tests ─────────────────────────────────

func runQualityGateTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	// Decode the quality gate from input
	qgRaw := bt.Test.Input["qualityGate"]
	qgJSON := marshalHelper(t, qgRaw)
	var qg core.QualityGate
	require.NoError(t, json.Unmarshal(qgJSON, &qg))

	// Decode the context
	ctxRaw := bt.Test.Input["context"].(map[string]interface{})

	evalCtx := &policy.EvaluationContext{
		Metrics: make(map[string]float64),
	}

	if metricsRaw, ok := ctxRaw["metrics"].(map[string]interface{}); ok {
		for k, v := range metricsRaw {
			evalCtx.Metrics[k] = toFloat64(v)
		}
	}
	if or, ok := ctxRaw["overrideRole"].(string); ok {
		evalCtx.OverrideRole = or
	}

	result := policy.Enforce(context.Background(), &qg, evalCtx)

	expectedAllowed := toBool(bt.Test.Expected["allowed"])
	assert.Equal(t, expectedAllowed, result.Passed,
		"expected allowed=%v for %s", expectedAllowed, bt.Description)
}

// ── Autonomy Promotion Tests ──────────────────────────────────────

func runAutonomyPromotionTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	policyRaw := bt.Test.Input["policy"]
	policyJSON := marshalHelper(t, policyRaw)
	var ap core.AutonomyPolicy
	require.NoError(t, json.Unmarshal(policyJSON, &ap))

	agentRaw := bt.Test.Input["agent"].(map[string]interface{})
	currentLevel := toInt(agentRaw["currentLevel"])
	totalTasks := toInt(agentRaw["totalTasksCompleted"])

	metrics := make(map[string]float64)
	if mr, ok := agentRaw["metrics"].(map[string]interface{}); ok {
		for k, v := range mr {
			metrics[k] = toFloat64(v)
		}
	}

	var approvals []string
	if ar, ok := agentRaw["approvals"].([]interface{}); ok {
		for _, a := range ar {
			approvals = append(approvals, fmt.Sprint(a))
		}
	}

	result := policy.EvaluatePromotion(&ap, currentLevel, &policy.AgentMetrics{
		TasksCompleted: totalTasks,
		Metrics:        metrics,
		Approvals:      approvals,
	})

	expectedEligible := toBool(bt.Test.Expected["eligible"])
	assert.Equal(t, expectedEligible, result.Eligible,
		"expected eligible=%v for %s (reasons: %v)", expectedEligible, bt.Description, result.Reasons)

	if expectedEligible {
		assert.Equal(t, toInt(bt.Test.Expected["fromLevel"]), result.FromLevel)
		assert.Equal(t, toInt(bt.Test.Expected["toLevel"]), result.ToLevel)
	}
}

// ── Autonomy Demotion Tests ───────────────────────────────────────

func runAutonomyDemotionTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	policyRaw := bt.Test.Input["policy"]
	policyJSON := marshalHelper(t, policyRaw)
	var ap core.AutonomyPolicy
	require.NoError(t, json.Unmarshal(policyJSON, &ap))

	agentRaw := bt.Test.Input["agent"].(map[string]interface{})
	currentLevel := toInt(agentRaw["currentLevel"])
	activeTrigger := bt.Test.Input["activeTrigger"].(string)

	result := policy.EvaluateDemotion(&ap, currentLevel, activeTrigger)

	expectedDemoted := toBool(bt.Test.Expected["demoted"])
	assert.Equal(t, expectedDemoted, result.Demoted,
		"expected demoted=%v for %s", expectedDemoted, bt.Description)

	if expectedDemoted {
		assert.Equal(t, toInt(bt.Test.Expected["fromLevel"]), result.FromLevel)
		assert.Equal(t, toInt(bt.Test.Expected["toLevel"]), result.ToLevel)
	}
}

// ── Complexity Routing Tests ──────────────────────────────────────

func runComplexityRoutingTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	ciRaw := bt.Test.Input["complexityInput"].(map[string]interface{})
	input := &policy.ComplexityInput{
		FilesAffected:      toInt(ciRaw["filesAffected"]),
		LinesOfChange:      toInt(ciRaw["linesOfChange"]),
		SecuritySensitive:  toBool(ciRaw["securitySensitive"]),
		APIChange:          toBool(ciRaw["apiChange"]),
		DatabaseMigration:  toBool(ciRaw["databaseMigration"]),
		CrossServiceChange: toBool(ciRaw["crossServiceChange"]),
	}

	result := policy.EvaluateComplexity(input, nil)

	minScore := toInt(bt.Test.Expected["minScore"])
	maxScore := toInt(bt.Test.Expected["maxScore"])
	expectedStrategy := bt.Test.Expected["strategy"].(string)

	assert.GreaterOrEqual(t, result.Score, minScore,
		"score %d below minimum %d for %s", result.Score, minScore, bt.Description)
	assert.LessOrEqual(t, result.Score, maxScore,
		"score %d above maximum %d for %s", result.Score, maxScore, bt.Description)
	assert.Equal(t, expectedStrategy, result.Strategy,
		"expected strategy %s for %s", expectedStrategy, bt.Description)
}

// ── Handoff Validation Tests ──────────────────────────────────────

func runHandoffValidationTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	fromRaw := bt.Test.Input["from"]
	fromJSON := marshalHelper(t, fromRaw)
	var from core.AgentRole
	require.NoError(t, json.Unmarshal(fromJSON, &from))

	payloadRaw := bt.Test.Input["payload"].(map[string]interface{})

	// Find the handoff contract
	var requiredFields []string
	if len(from.Spec.Handoffs) > 0 && from.Spec.Handoffs[0].Contract != nil {
		requiredFields = from.Spec.Handoffs[0].Contract.RequiredFields
	}

	err := agents.ValidateHandoff(payloadRaw, requiredFields)
	expectedValid := toBool(bt.Test.Expected["valid"])

	if expectedValid {
		assert.NoError(t, err, "expected valid handoff for %s", bt.Description)
	} else {
		assert.Error(t, err, "expected invalid handoff for %s", bt.Description)
	}
}

// ── Orchestration Error Tests ─────────────────────────────────────

func runOrchestrationErrorTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	planRaw := bt.Test.Input["plan"].(map[string]interface{})
	agentsRaw, _ := bt.Test.Input["agents"].(map[string]interface{})
	failAgent, _ := bt.Test.Input["failAgent"].(string)

	// Build steps
	stepsRaw := planRaw["steps"].([]interface{})
	var steps []agents.OrchestrationStep
	for _, sr := range stepsRaw {
		sMap := sr.(map[string]interface{})
		step := agents.OrchestrationStep{
			Name:  sMap["agent"].(string),
			Agent: sMap["agent"].(string),
		}
		if deps, ok := sMap["dependsOn"].([]interface{}); ok {
			for _, d := range deps {
				step.DependsOn = append(step.DependsOn, d.(string))
			}
		}
		steps = append(steps, step)
	}

	plan := agents.Sequential(steps...)

	// Create executor that fails for the designated agent or agents not in registry
	executor := func(ctx context.Context, step *agents.OrchestrationStep) (*agents.StepResult, error) {
		// Check if agent exists in the registry
		if _, ok := agentsRaw[step.Agent]; !ok {
			return &agents.StepResult{
				StepName:  step.Name,
				Succeeded: false,
				Error:     fmt.Sprintf("agent %q not found", step.Agent),
			}, nil
		}
		if step.Agent == failAgent {
			return &agents.StepResult{
				StepName:  step.Name,
				Succeeded: false,
				Error:     "simulated failure",
			}, nil
		}
		return &agents.StepResult{StepName: step.Name, Succeeded: true}, nil
	}

	result, err := agents.ExecuteOrchestration(context.Background(), plan, executor)
	require.NoError(t, err)

	expectedSuccess := toBool(bt.Test.Expected["success"])
	assert.Equal(t, expectedSuccess, result.Succeeded,
		"expected success=%v for %s", expectedSuccess, bt.Description)
}

// ── Pipeline Failure Policy Tests ─────────────────────────────────

func runPipelineFailurePolicyTest(t *testing.T, bt behavioralTest) {
	t.Helper()

	pipeRaw := bt.Test.Input["pipeline"]
	pipeJSON := marshalHelper(t, pipeRaw)
	var pipeline core.Pipeline
	require.NoError(t, json.Unmarshal(pipeJSON, &pipeline))

	failStage := bt.Test.Input["failStage"].(string)

	// Simulate stage execution with the failure policy
	var reachedStages []string
	var skippedStages []string
	finalPhase := core.PhaseSucceeded
	stageAttempts := make(map[string]int)

	if pipeline.Status != nil && pipeline.Status.StageAttempts != nil {
		for k, v := range pipeline.Status.StageAttempts {
			stageAttempts[k] = v
		}
	}

	for _, stage := range pipeline.Spec.Stages {
		if finalPhase == core.PhaseFailed {
			skippedStages = append(skippedStages, stage.Name)
			continue
		}

		reachedStages = append(reachedStages, stage.Name)

		if stage.Name == failStage {
			// Stage failed
			if stage.OnFailure != nil {
				switch stage.OnFailure.Strategy {
				case core.FailureAbort:
					finalPhase = core.PhaseFailed
				case core.FailureContinue:
					// Continue to next stage
				case core.FailureRetry:
					stageAttempts[stage.Name]++
					// Don't fail the pipeline for retry test — just record the increment
				default:
					finalPhase = core.PhaseFailed
				}
			} else {
				finalPhase = core.PhaseFailed
			}
		}
	}

	expected := bt.Test.Expected

	// Check phase if expected
	if ep, ok := expected["phase"].(string); ok {
		assert.Equal(t, ep, string(finalPhase),
			"expected phase %s for %s", ep, bt.Description)
	}

	// Check reached stages
	if ers, ok := expected["reachedStages"].([]interface{}); ok {
		var expectedReached []string
		for _, s := range ers {
			expectedReached = append(expectedReached, s.(string))
		}
		assert.Equal(t, expectedReached, reachedStages,
			"reached stages mismatch for %s", bt.Description)
	}

	// Check skipped stages
	if ess, ok := expected["skippedStages"].([]interface{}); ok {
		var expectedSkipped []string
		for _, s := range ess {
			expectedSkipped = append(expectedSkipped, s.(string))
		}
		assert.Equal(t, expectedSkipped, skippedStages,
			"skipped stages mismatch for %s", bt.Description)
	}

	// Check stage attempts incremented
	if sai, ok := expected["stageAttemptsIncremented"]; ok && toBool(sai) {
		assert.Greater(t, stageAttempts[failStage], 0,
			"stage attempts should be incremented for %s", bt.Description)
	}

	// Check max attempts before fail
	if mabf, ok := expected["maxAttemptsBeforeFail"]; ok {
		maxAttempts := toInt(mabf)
		for _, stage := range pipeline.Spec.Stages {
			if stage.Name == failStage && stage.OnFailure != nil && stage.OnFailure.MaxRetries != nil {
				assert.Equal(t, maxAttempts, *stage.OnFailure.MaxRetries,
					"maxRetries mismatch for %s", bt.Description)
			}
		}
	}
}

// ── Helper Functions ──────────────────────────────────────────────

func marshalHelper(t *testing.T, v interface{}) []byte {
	t.Helper()
	j, err := json.Marshal(v)
	require.NoError(t, err)
	return j
}

func toFloat64(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	default:
		return 0
	}
}

func toInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case int64:
		return int(n)
	default:
		return 0
	}
}

func toBool(v interface{}) bool {
	switch b := v.(type) {
	case bool:
		return b
	default:
		return false
	}
}

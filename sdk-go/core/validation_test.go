package core

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValidateValidPipeline(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   map[string]interface{}{"name": "test-pipeline"},
		"spec": map[string]interface{}{
			"triggers":  []interface{}{map[string]interface{}{"event": "issue.assigned"}},
			"providers": map[string]interface{}{"issueTracker": map[string]interface{}{"type": "linear"}},
			"stages":    []interface{}{map[string]interface{}{"name": "plan"}},
		},
	}

	result := Validate(KindPipeline, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateInvalidPipeline(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   map[string]interface{}{"name": "test-pipeline"},
		"spec": map[string]interface{}{
			// missing required "triggers", "providers", "stages"
		},
	}

	result := Validate(KindPipeline, data)
	assert.False(t, result.Valid)
	assert.NotEmpty(t, result.Errors)
}

func TestValidateValidAgentRole(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "AgentRole",
		"metadata":   map[string]interface{}{"name": "coder-agent"},
		"spec": map[string]interface{}{
			"role":  "Senior Software Engineer",
			"goal":  "Write high-quality code",
			"tools": []interface{}{"git", "vscode"},
		},
	}

	result := Validate(KindAgentRole, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateValidQualityGate(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "QualityGate",
		"metadata":   map[string]interface{}{"name": "code-quality"},
		"spec": map[string]interface{}{
			"gates": []interface{}{
				map[string]interface{}{
					"name":        "coverage",
					"enforcement": "hard-mandatory",
					"rule": map[string]interface{}{
						"metric":    "coverage",
						"operator":  ">=",
						"threshold": 80.0,
					},
				},
			},
		},
	}

	result := Validate(KindQualityGate, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateValidAutonomyPolicy(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "AutonomyPolicy",
		"metadata":   map[string]interface{}{"name": "progressive"},
		"spec": map[string]interface{}{
			"levels": []interface{}{
				map[string]interface{}{
					"level": 0,
					"name":  "Intern",
					"permissions": map[string]interface{}{
						"read":    []interface{}{"*"},
						"write":   []interface{}{"draft-pr"},
						"execute": []interface{}{"test"},
					},
					"guardrails": map[string]interface{}{
						"requireApproval": "all",
					},
					"monitoring": "continuous",
				},
			},
			"promotionCriteria": map[string]interface{}{
				"0-to-1": map[string]interface{}{
					"minimumTasks": 10,
					"conditions": []interface{}{
						map[string]interface{}{"metric": "approval-rate", "operator": ">=", "threshold": 0.9},
					},
					"requiredApprovals": []interface{}{"tech-lead"},
				},
			},
			"demotionTriggers": []interface{}{
				map[string]interface{}{
					"trigger":  "security-violation",
					"action":   "demote-to-0",
					"cooldown": "7d",
				},
			},
		},
	}

	result := Validate(KindAutonomyPolicy, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateValidAdapterBinding(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "AdapterBinding",
		"metadata":   map[string]interface{}{"name": "linear-binding"},
		"spec": map[string]interface{}{
			"interface": "IssueTracker",
			"type":      "linear",
			"version":   "1.0.0",
		},
	}

	result := Validate(KindAdapterBinding, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateResourceInferKind(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   map[string]interface{}{"name": "p"},
		"spec": map[string]interface{}{
			"triggers":  []interface{}{map[string]interface{}{"event": "push"}},
			"providers": map[string]interface{}{"ci": map[string]interface{}{"type": "github"}},
			"stages":    []interface{}{map[string]interface{}{"name": "build"}},
		},
	}

	result := ValidateResource(data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)
}

func TestValidateResourceMissingKind(t *testing.T) {
	result := ValidateResource(map[string]interface{}{"metadata": map[string]interface{}{"name": "x"}})
	assert.False(t, result.Valid)
	assert.Equal(t, `missing "kind" field`, result.Errors[0].Message)
}

func TestValidateResourceUnknownKind(t *testing.T) {
	result := ValidateResource(map[string]interface{}{"kind": "Bogus"})
	assert.False(t, result.Valid)
	assert.Contains(t, result.Errors[0].Message, "unknown resource kind")
}

func TestValidateUnknownKind(t *testing.T) {
	result := Validate("UnknownKind", nil)
	assert.False(t, result.Valid)
}

func TestValidateMetadataNamePattern(t *testing.T) {
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "Pipeline",
		"metadata":   map[string]interface{}{"name": "INVALID_NAME"},
		"spec": map[string]interface{}{
			"triggers":  []interface{}{map[string]interface{}{"event": "push"}},
			"providers": map[string]interface{}{"ci": map[string]interface{}{"type": "github"}},
			"stages":    []interface{}{map[string]interface{}{"name": "build"}},
		},
	}

	result := Validate(KindPipeline, data)
	assert.False(t, result.Valid)
}

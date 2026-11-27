package core

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
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
		"spec":       map[string]interface{}{
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

func TestValidateAgentRoleSyncedSurface(t *testing.T) {
	// AISDLC-604: fields present in the canonical schema must be accepted.
	data := map[string]interface{}{
		"apiVersion": "ai-sdlc.io/v1alpha1",
		"kind":       "AgentRole",
		"metadata":   map[string]interface{}{"name": "coder-agent"},
		"spec": map[string]interface{}{
			"role":         "Senior Software Engineer",
			"goal":         "Write high-quality code",
			"tools":        []interface{}{"git"},
			"scope":        "soul",
			"soulBindings": []interface{}{"did:platform-x:soul:soul-a"},
			"designSystem": map[string]interface{}{"binding": "ds"},
			"constraints": map[string]interface{}{
				"blockedActions":    []interface{}{"rm -rf*"},
				"requireStory":      true,
				"requireTokenUsage": true,
			},
		},
	}
	result := Validate(KindAgentRole, data)
	assert.True(t, result.Valid, "expected valid, got errors: %v", result.Errors)

	data["spec"].(map[string]interface{})["scope"] = "bogus"
	assert.False(t, Validate(KindAgentRole, data).Valid)
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

func TestEmbeddedSchemasMatchSpec(t *testing.T) {
	entries, err := schemaFS.ReadDir("schemas")
	require.NoError(t, err)
	names := map[string]bool{}
	for _, entry := range entries {
		file := entry.Name()
		names[file] = true
		want, err := os.ReadFile(filepath.Join("..", "..", "spec", "schemas", file))
		require.NoError(t, err, "%s has no counterpart in spec/schemas", file)
		got, err := schemaFS.ReadFile("schemas/" + file)
		require.NoError(t, err)
		assert.True(t, bytes.Equal(want, got), "%s differs from spec/schemas", file)
	}
	// Every kind schema, the common schema and the journey schema the
	// DesignIntentDocument schema references are embedded.
	for _, file := range SchemaFiles {
		assert.True(t, names[file], "%s is not embedded", file)
	}
	assert.True(t, names["common.schema.json"])
	assert.True(t, names["journey.v1.schema.json"])
}

// fixtureDirs maps each schema-only kind to its conformance fixture directory.
var fixtureDirs = map[ResourceKind]string{
	KindDesignSystemBinding:  "design-system-binding",
	KindDesignIntentDocument: "design-intent-document",
	KindDorConfig:            "dor-config",
	KindCompliancePosture:    "compliance-posture",
	KindJudgmentConfig:       "judgment-config",
	KindCapabilitiesConfig:   "capabilities-config",
}

func loadFixture(t *testing.T, path string) interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	var raw interface{}
	require.NoError(t, yaml.Unmarshal(data, &raw))
	js, err := json.Marshal(raw)
	require.NoError(t, err)
	var doc interface{}
	require.NoError(t, json.Unmarshal(js, &doc))
	return doc
}

func TestValidateNewKindsAgainstFixtures(t *testing.T) {
	for kind, dir := range fixtureDirs {
		full := filepath.Join("..", "..", "conformance", "tests", "v1alpha1", dir)
		entries, err := os.ReadDir(full)
		require.NoError(t, err)
		var valid, invalid int
		for _, entry := range entries {
			name := entry.Name()
			if !strings.HasSuffix(name, ".yaml") {
				continue
			}
			doc := loadFixture(t, filepath.Join(full, name))
			result := Validate(kind, doc)
			switch {
			case strings.HasPrefix(name, "valid-"):
				valid++
				assert.True(t, result.Valid, "%s/%s: %v", dir, name, result.Errors)
				assert.True(t, ValidateResource(doc).Valid, "%s/%s via ValidateResource", dir, name)
			case strings.HasPrefix(name, "invalid-"):
				invalid++
				assert.False(t, result.Valid, "%s/%s passed validation", dir, name)
			}
		}
		assert.Positive(t, valid, "%s has no valid fixture", dir)
		assert.Positive(t, invalid, "%s has no invalid fixture", dir)
	}
}

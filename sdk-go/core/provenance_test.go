package core

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateProvenance(t *testing.T) {
	p := CreateProvenance("gpt-4", "cursor", "abc123")
	assert.Equal(t, "gpt-4", p.Model)
	assert.Equal(t, "cursor", p.Tool)
	assert.Equal(t, "abc123", p.PromptHash)
	assert.NotEmpty(t, p.Timestamp)
	assert.Equal(t, ReviewPending, p.ReviewDecision)
	assert.Empty(t, p.HumanReviewer)
}

func TestCreateProvenanceWithOptions(t *testing.T) {
	p := CreateProvenance("claude-3", "vscode", "hash",
		WithTimestamp("2024-01-01T00:00:00Z"),
		WithHumanReviewer("alice"),
		WithReviewDecision(ReviewApproved),
	)
	assert.Equal(t, "2024-01-01T00:00:00Z", p.Timestamp)
	assert.Equal(t, "alice", p.HumanReviewer)
	assert.Equal(t, ReviewApproved, p.ReviewDecision)
}

func TestProvenanceAnnotationRoundTrip(t *testing.T) {
	original := &ProvenanceRecord{
		Model:          "gpt-4",
		Tool:           "cursor",
		PromptHash:     "abc123",
		Timestamp:      "2024-01-01T00:00:00Z",
		HumanReviewer:  "alice",
		ReviewDecision: ReviewApproved,
	}

	annotations := ProvenanceToAnnotations(original)
	assert.Len(t, annotations, 6)
	assert.Equal(t, "gpt-4", annotations[ProvenanceAnnotationPrefix+"model"])

	restored := ProvenanceFromAnnotations(annotations)
	require.NotNil(t, restored)
	assert.Equal(t, original.Model, restored.Model)
	assert.Equal(t, original.Tool, restored.Tool)
	assert.Equal(t, original.PromptHash, restored.PromptHash)
	assert.Equal(t, original.Timestamp, restored.Timestamp)
	assert.Equal(t, original.HumanReviewer, restored.HumanReviewer)
	assert.Equal(t, original.ReviewDecision, restored.ReviewDecision)
}

func TestProvenanceFromAnnotationsMissing(t *testing.T) {
	result := ProvenanceFromAnnotations(map[string]string{
		ProvenanceAnnotationPrefix + "model": "gpt-4",
	})
	assert.Nil(t, result)
}

func TestProvenanceWithoutReviewer(t *testing.T) {
	p := &ProvenanceRecord{
		Model:          "gpt-4",
		Tool:           "cursor",
		PromptHash:     "abc",
		Timestamp:      "2024-01-01T00:00:00Z",
		ReviewDecision: ReviewPending,
	}
	annotations := ProvenanceToAnnotations(p)
	assert.Len(t, annotations, 5) // no humanReviewer key
}

func TestValidateProvenance(t *testing.T) {
	valid, missing := ValidateProvenance(map[string]string{
		"model":          "gpt-4",
		"tool":           "cursor",
		"promptHash":     "abc",
		"timestamp":      "2024-01-01T00:00:00Z",
		"reviewDecision": "approved",
	})
	assert.True(t, valid)
	assert.Empty(t, missing)
}

func TestValidateProvenanceMissing(t *testing.T) {
	valid, missing := ValidateProvenance(map[string]string{
		"model": "gpt-4",
	})
	assert.False(t, valid)
	assert.Contains(t, missing, "tool")
	assert.Contains(t, missing, "promptHash")
	assert.Contains(t, missing, "timestamp")
	assert.Contains(t, missing, "reviewDecision")
}

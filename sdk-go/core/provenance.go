package core

import "time"

// ReviewDecision represents the outcome of a human review.
type ReviewDecision string

const (
	ReviewApproved    ReviewDecision = "approved"
	ReviewRejected    ReviewDecision = "rejected"
	ReviewPending     ReviewDecision = "pending"
	ReviewNotRequired ReviewDecision = "not-required"
)

// ProvenanceAnnotationPrefix is the prefix used for provenance annotations.
const ProvenanceAnnotationPrefix = "ai-sdlc.io/provenance-"

// ProvenanceRecord contains the provenance metadata for AI-generated content.
type ProvenanceRecord struct {
	Model          string         `json:"model"`
	Tool           string         `json:"tool"`
	PromptHash     string         `json:"promptHash"`
	Timestamp      string         `json:"timestamp"`
	HumanReviewer  string         `json:"humanReviewer,omitempty"`
	ReviewDecision ReviewDecision `json:"reviewDecision"`
}

// CreateProvenance creates a provenance record with defaults for optional fields.
func CreateProvenance(model, tool, promptHash string, opts ...ProvenanceOption) *ProvenanceRecord {
	p := &ProvenanceRecord{
		Model:          model,
		Tool:           tool,
		PromptHash:     promptHash,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
		ReviewDecision: ReviewPending,
	}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

// ProvenanceOption configures optional fields on a ProvenanceRecord.
type ProvenanceOption func(*ProvenanceRecord)

// WithTimestamp sets a specific timestamp.
func WithTimestamp(ts string) ProvenanceOption {
	return func(p *ProvenanceRecord) { p.Timestamp = ts }
}

// WithHumanReviewer sets the human reviewer.
func WithHumanReviewer(reviewer string) ProvenanceOption {
	return func(p *ProvenanceRecord) { p.HumanReviewer = reviewer }
}

// WithReviewDecision sets the review decision.
func WithReviewDecision(decision ReviewDecision) ProvenanceOption {
	return func(p *ProvenanceRecord) { p.ReviewDecision = decision }
}

// ProvenanceToAnnotations serializes a provenance record to annotation key-value pairs.
func ProvenanceToAnnotations(p *ProvenanceRecord) map[string]string {
	a := map[string]string{
		ProvenanceAnnotationPrefix + "model":          p.Model,
		ProvenanceAnnotationPrefix + "tool":           p.Tool,
		ProvenanceAnnotationPrefix + "promptHash":     p.PromptHash,
		ProvenanceAnnotationPrefix + "timestamp":      p.Timestamp,
		ProvenanceAnnotationPrefix + "reviewDecision": string(p.ReviewDecision),
	}
	if p.HumanReviewer != "" {
		a[ProvenanceAnnotationPrefix+"humanReviewer"] = p.HumanReviewer
	}
	return a
}

// ProvenanceFromAnnotations deserializes a provenance record from annotations.
// Returns nil if required fields are missing.
func ProvenanceFromAnnotations(annotations map[string]string) *ProvenanceRecord {
	get := func(field string) string {
		return annotations[ProvenanceAnnotationPrefix+field]
	}

	model := get("model")
	tool := get("tool")
	promptHash := get("promptHash")
	timestamp := get("timestamp")
	reviewDecision := get("reviewDecision")

	if model == "" || tool == "" || promptHash == "" || timestamp == "" || reviewDecision == "" {
		return nil
	}

	return &ProvenanceRecord{
		Model:          model,
		Tool:           tool,
		PromptHash:     promptHash,
		Timestamp:      timestamp,
		HumanReviewer:  get("humanReviewer"),
		ReviewDecision: ReviewDecision(reviewDecision),
	}
}

// ValidateProvenance validates that a provenance record has all required fields.
// Returns (valid, missingFields).
func ValidateProvenance(p map[string]string) (bool, []string) {
	required := []string{"model", "tool", "promptHash", "timestamp", "reviewDecision"}
	var missing []string
	for _, f := range required {
		if v, ok := p[f]; !ok || v == "" {
			missing = append(missing, f)
		}
	}
	return len(missing) == 0, missing
}

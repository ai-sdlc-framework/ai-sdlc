package policy

import (
	"math"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// ComplexityInput contains the factors used to score complexity.
// Field names match the conformance test fixtures.
type ComplexityInput struct {
	FilesAffected      int  `json:"filesAffected" yaml:"filesAffected"`
	LinesOfChange      int  `json:"linesOfChange" yaml:"linesOfChange"`
	SecuritySensitive  bool `json:"securitySensitive" yaml:"securitySensitive"`
	APIChange          bool `json:"apiChange" yaml:"apiChange"`
	DatabaseMigration  bool `json:"databaseMigration" yaml:"databaseMigration"`
	CrossServiceChange bool `json:"crossServiceChange" yaml:"crossServiceChange"`
	NewDependencies    int  `json:"newDependencies,omitempty" yaml:"newDependencies,omitempty"`
	CustomScore        *int `json:"-" yaml:"-"`
}

// ComplexityResult is the outcome of complexity scoring.
type ComplexityResult struct {
	Score    int    `json:"score"`
	Tier     string `json:"tier"`
	Strategy string `json:"strategy"`
}

// ComplexityFactor defines a weighted scoring factor.
type ComplexityFactor struct {
	Name   string
	Weight float64
	Score  func(input *ComplexityInput) float64
}

// DefaultComplexityFactors mirrors the TS reference implementation.
var DefaultComplexityFactors = []ComplexityFactor{
	{
		Name:   "fileScope",
		Weight: 0.2,
		Score: func(input *ComplexityInput) float64 {
			return math.Min(10, math.Ceil(float64(input.FilesAffected)/5.0))
		},
	},
	{
		Name:   "changeSize",
		Weight: 0.2,
		Score: func(input *ComplexityInput) float64 {
			return math.Min(10, math.Ceil(float64(input.LinesOfChange)/100.0))
		},
	},
	{
		Name:   "security",
		Weight: 0.2,
		Score: func(input *ComplexityInput) float64 {
			if input.SecuritySensitive {
				return 10
			}
			return 1
		},
	},
	{
		Name:   "apiChange",
		Weight: 0.15,
		Score: func(input *ComplexityInput) float64 {
			if input.APIChange {
				return 8
			}
			return 1
		},
	},
	{
		Name:   "databaseMigration",
		Weight: 0.15,
		Score: func(input *ComplexityInput) float64 {
			if input.DatabaseMigration {
				return 9
			}
			return 1
		},
	},
	{
		Name:   "crossService",
		Weight: 0.1,
		Score: func(input *ComplexityInput) float64 {
			if input.CrossServiceChange {
				return 8
			}
			return 1
		},
	},
}

// DefaultThresholds defines the default complexity tier routing.
var DefaultThresholds = map[string]core.ComplexityThreshold{
	"low":      {Min: 1, Max: 3, Strategy: "fully-autonomous"},
	"medium":   {Min: 4, Max: 6, Strategy: "ai-with-review"},
	"high":     {Min: 7, Max: 8, Strategy: "ai-assisted"},
	"critical": {Min: 9, Max: 10, Strategy: "human-led"},
}

// ScoreComplexity computes a complexity score from 1-10 using weighted factors.
func ScoreComplexity(input *ComplexityInput) int {
	if input.CustomScore != nil {
		score := *input.CustomScore
		if score < 1 {
			return 1
		}
		if score > 10 {
			return 10
		}
		return score
	}

	return ScoreComplexityWithFactors(input, DefaultComplexityFactors)
}

// ScoreComplexityWithFactors computes complexity using custom factors.
func ScoreComplexityWithFactors(input *ComplexityInput, factors []ComplexityFactor) int {
	var totalWeight, weightedSum float64

	for _, factor := range factors {
		raw := math.Max(1, math.Min(10, factor.Score(input)))
		weightedSum += raw * factor.Weight
		totalWeight += factor.Weight
	}

	if totalWeight == 0 {
		return 1
	}

	score := int(math.Round(weightedSum / totalWeight))
	if score < 1 {
		return 1
	}
	if score > 10 {
		return 10
	}
	return score
}

// RouteByComplexity determines the routing strategy for a given complexity score.
func RouteByComplexity(routing *core.RoutingConfig, score int) *ComplexityResult {
	if routing == nil || routing.ComplexityThresholds == nil {
		// Use default thresholds
		return routeByThresholds(DefaultThresholds, score)
	}

	return routeByThresholds(routing.ComplexityThresholds, score)
}

func routeByThresholds(thresholds map[string]core.ComplexityThreshold, score int) *ComplexityResult {
	for tier, threshold := range thresholds {
		if score >= threshold.Min && score <= threshold.Max {
			return &ComplexityResult{
				Score:    score,
				Tier:     tier,
				Strategy: threshold.Strategy,
			}
		}
	}

	// Fallback
	strategy := "ai-with-review"
	if score >= 7 {
		strategy = "human-led"
	}
	return &ComplexityResult{Score: score, Tier: "unmatched", Strategy: strategy}
}

// EvaluateComplexity scores and routes a task.
func EvaluateComplexity(input *ComplexityInput, routing *core.RoutingConfig) *ComplexityResult {
	score := ScoreComplexity(input)
	return RouteByComplexity(routing, score)
}

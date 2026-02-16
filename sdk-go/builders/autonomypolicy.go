package builders

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AutonomyPolicyBuilder constructs an AutonomyPolicy resource via method chaining.
type AutonomyPolicyBuilder struct {
	name              string
	namespace         string
	labels            map[string]string
	levels            []core.AutonomyLevel
	promotionCriteria map[string]core.PromotionCriteria
	demotionTriggers  []core.DemotionTrigger
}

// NewAutonomyPolicyBuilder creates a new AutonomyPolicyBuilder.
func NewAutonomyPolicyBuilder(name string) *AutonomyPolicyBuilder {
	return &AutonomyPolicyBuilder{
		name:              name,
		labels:            make(map[string]string),
		promotionCriteria: make(map[string]core.PromotionCriteria),
	}
}

func (b *AutonomyPolicyBuilder) Namespace(ns string) *AutonomyPolicyBuilder {
	b.namespace = ns
	return b
}

func (b *AutonomyPolicyBuilder) Label(key, value string) *AutonomyPolicyBuilder {
	b.labels[key] = value
	return b
}

func (b *AutonomyPolicyBuilder) AddLevel(level core.AutonomyLevel) *AutonomyPolicyBuilder {
	b.levels = append(b.levels, level)
	return b
}

func (b *AutonomyPolicyBuilder) AddPromotionCriteria(transition string, criteria core.PromotionCriteria) *AutonomyPolicyBuilder {
	b.promotionCriteria[transition] = criteria
	return b
}

func (b *AutonomyPolicyBuilder) AddDemotionTrigger(trigger core.DemotionTrigger) *AutonomyPolicyBuilder {
	b.demotionTriggers = append(b.demotionTriggers, trigger)
	return b
}

// Build validates and returns the AutonomyPolicy resource.
func (b *AutonomyPolicyBuilder) Build() (*core.AutonomyPolicy, error) {
	if b.name == "" {
		return nil, fmt.Errorf("autonomy policy name is required")
	}
	if len(b.levels) == 0 {
		return nil, fmt.Errorf("at least one level is required")
	}
	if len(b.demotionTriggers) == 0 {
		return nil, fmt.Errorf("at least one demotion trigger is required")
	}

	a := &core.AutonomyPolicy{
		APIVersion: core.APIVersion,
		Kind:       string(core.KindAutonomyPolicy),
		Metadata: core.Metadata{
			Name:      b.name,
			Namespace: b.namespace,
		},
		Spec: core.AutonomyPolicySpec{
			Levels:            b.levels,
			PromotionCriteria: b.promotionCriteria,
			DemotionTriggers:  b.demotionTriggers,
		},
	}
	if len(b.labels) > 0 {
		a.Metadata.Labels = b.labels
	}
	return a, nil
}

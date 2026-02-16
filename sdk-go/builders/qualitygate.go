package builders

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// QualityGateBuilder constructs a QualityGate resource via method chaining.
type QualityGateBuilder struct {
	name       string
	namespace  string
	labels     map[string]string
	scope      *core.GateScope
	gates      []core.Gate
	evaluation *core.Evaluation
}

// NewQualityGateBuilder creates a new QualityGateBuilder.
func NewQualityGateBuilder(name string) *QualityGateBuilder {
	return &QualityGateBuilder{
		name:   name,
		labels: make(map[string]string),
	}
}

func (b *QualityGateBuilder) Namespace(ns string) *QualityGateBuilder {
	b.namespace = ns
	return b
}

func (b *QualityGateBuilder) Label(key, value string) *QualityGateBuilder {
	b.labels[key] = value
	return b
}

func (b *QualityGateBuilder) WithScope(scope *core.GateScope) *QualityGateBuilder {
	b.scope = scope
	return b
}

func (b *QualityGateBuilder) AddGate(name string, enforcement core.EnforcementLevel, rule core.GateRule, override *core.Override) *QualityGateBuilder {
	b.gates = append(b.gates, core.Gate{
		Name:        name,
		Enforcement: enforcement,
		Rule:        rule,
		Override:    override,
	})
	return b
}

func (b *QualityGateBuilder) WithEvaluation(eval *core.Evaluation) *QualityGateBuilder {
	b.evaluation = eval
	return b
}

// Build validates and returns the QualityGate resource.
func (b *QualityGateBuilder) Build() (*core.QualityGate, error) {
	if b.name == "" {
		return nil, fmt.Errorf("quality gate name is required")
	}
	if len(b.gates) == 0 {
		return nil, fmt.Errorf("at least one gate is required")
	}

	q := &core.QualityGate{
		APIVersion: core.APIVersion,
		Kind:       string(core.KindQualityGate),
		Metadata: core.Metadata{
			Name:      b.name,
			Namespace: b.namespace,
		},
		Spec: core.QualityGateSpec{
			Scope:      b.scope,
			Gates:      b.gates,
			Evaluation: b.evaluation,
		},
	}
	if len(b.labels) > 0 {
		q.Metadata.Labels = b.labels
	}
	return q, nil
}

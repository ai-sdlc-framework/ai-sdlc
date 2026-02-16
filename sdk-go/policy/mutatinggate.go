package policy

import "github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"

// MutatingGate modifies a resource before or after gate evaluation.
type MutatingGate interface {
	Mutate(resource core.AnyResource) error
}

// LabelInjector adds labels to resources.
type LabelInjector struct {
	Labels map[string]string
}

// NewLabelInjector creates a MutatingGate that injects labels.
func NewLabelInjector(labels map[string]string) *LabelInjector {
	return &LabelInjector{Labels: labels}
}

func (l *LabelInjector) Mutate(resource core.AnyResource) error {
	meta := resource.GetMetadata()
	if meta.Labels == nil {
		meta.Labels = make(map[string]string)
	}
	for k, v := range l.Labels {
		meta.Labels[k] = v
	}
	return nil
}

// MetadataEnricher adds annotations to resources.
type MetadataEnricher struct {
	Annotations map[string]string
}

// NewMetadataEnricher creates a MutatingGate that enriches annotations.
func NewMetadataEnricher(annotations map[string]string) *MetadataEnricher {
	return &MetadataEnricher{Annotations: annotations}
}

func (m *MetadataEnricher) Mutate(resource core.AnyResource) error {
	meta := resource.GetMetadata()
	if meta.Annotations == nil {
		meta.Annotations = make(map[string]string)
	}
	for k, v := range m.Annotations {
		meta.Annotations[k] = v
	}
	return nil
}

// ApplyMutatingGates applies all mutating gates in order.
func ApplyMutatingGates(resource core.AnyResource, gates ...MutatingGate) error {
	for _, g := range gates {
		if err := g.Mutate(resource); err != nil {
			return err
		}
	}
	return nil
}

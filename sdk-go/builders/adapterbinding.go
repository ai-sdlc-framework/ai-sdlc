package builders

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AdapterBindingBuilder constructs an AdapterBinding resource via method chaining.
type AdapterBindingBuilder struct {
	name        string
	namespace   string
	labels      map[string]string
	iface       core.AdapterInterface
	adapterType string
	version     string
	source      string
	config      map[string]interface{}
	healthCheck *core.HealthCheck
}

// NewAdapterBindingBuilder creates a new AdapterBindingBuilder.
func NewAdapterBindingBuilder(name string) *AdapterBindingBuilder {
	return &AdapterBindingBuilder{
		name:   name,
		labels: make(map[string]string),
	}
}

func (b *AdapterBindingBuilder) Namespace(ns string) *AdapterBindingBuilder {
	b.namespace = ns
	return b
}

func (b *AdapterBindingBuilder) Label(key, value string) *AdapterBindingBuilder {
	b.labels[key] = value
	return b
}

func (b *AdapterBindingBuilder) Interface(iface core.AdapterInterface) *AdapterBindingBuilder {
	b.iface = iface
	return b
}

func (b *AdapterBindingBuilder) Type(adapterType string) *AdapterBindingBuilder {
	b.adapterType = adapterType
	return b
}

func (b *AdapterBindingBuilder) Version(version string) *AdapterBindingBuilder {
	b.version = version
	return b
}

func (b *AdapterBindingBuilder) Source(source string) *AdapterBindingBuilder {
	b.source = source
	return b
}

func (b *AdapterBindingBuilder) Config(config map[string]interface{}) *AdapterBindingBuilder {
	b.config = config
	return b
}

func (b *AdapterBindingBuilder) WithHealthCheck(hc *core.HealthCheck) *AdapterBindingBuilder {
	b.healthCheck = hc
	return b
}

// Build validates and returns the AdapterBinding resource.
func (b *AdapterBindingBuilder) Build() (*core.AdapterBinding, error) {
	if b.name == "" {
		return nil, fmt.Errorf("adapter binding name is required")
	}
	if b.iface == "" {
		return nil, fmt.Errorf("interface is required")
	}
	if b.adapterType == "" {
		return nil, fmt.Errorf("type is required")
	}
	if b.version == "" {
		return nil, fmt.Errorf("version is required")
	}

	a := &core.AdapterBinding{
		APIVersion: core.APIVersion,
		Kind:       string(core.KindAdapterBinding),
		Metadata: core.Metadata{
			Name:      b.name,
			Namespace: b.namespace,
		},
		Spec: core.AdapterBindingSpec{
			Interface:   b.iface,
			Type:        b.adapterType,
			Version:     b.version,
			Source:      b.source,
			Config:      b.config,
			HealthCheck: b.healthCheck,
		},
	}
	if len(b.labels) > 0 {
		a.Metadata.Labels = b.labels
	}
	return a, nil
}

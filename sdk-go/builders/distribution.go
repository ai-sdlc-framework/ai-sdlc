package builders

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// ManifestEntry represents a resource reference in a distribution manifest.
type ManifestEntry struct {
	Path string `json:"path" yaml:"path"`
	Kind string `json:"kind" yaml:"kind"`
	Name string `json:"name" yaml:"name"`
}

// DistributionManifest represents a collection of AI-SDLC resources.
type DistributionManifest struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Metadata   ManifestMeta    `json:"metadata" yaml:"metadata"`
	Resources  []ManifestEntry `json:"resources" yaml:"resources"`
}

// ManifestMeta is the metadata for a distribution manifest.
type ManifestMeta struct {
	Name    string `json:"name" yaml:"name"`
	Version string `json:"version,omitempty" yaml:"version,omitempty"`
}

// ParseBuilderManifest parses a YAML distribution manifest.
func ParseBuilderManifest(data []byte) (*DistributionManifest, error) {
	var m DistributionManifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("failed to parse manifest: %w", err)
	}
	return &m, nil
}

// ValidateBuilderManifest checks that a manifest has all required fields.
func ValidateBuilderManifest(m *DistributionManifest) error {
	if m.Metadata.Name == "" {
		return fmt.Errorf("manifest metadata.name is required")
	}
	if len(m.Resources) == 0 {
		return fmt.Errorf("manifest must contain at least one resource")
	}
	for i, r := range m.Resources {
		if r.Path == "" {
			return fmt.Errorf("resource[%d].path is required", i)
		}
		if r.Kind == "" {
			return fmt.Errorf("resource[%d].kind is required", i)
		}
		if r.Name == "" {
			return fmt.Errorf("resource[%d].name is required", i)
		}
	}
	return nil
}

// BuildDistribution creates a validated manifest from its parts.
func BuildDistribution(name, version string, resources []ManifestEntry) (*DistributionManifest, error) {
	m := &DistributionManifest{
		APIVersion: "ai-sdlc.io/v1alpha1",
		Kind:       "Distribution",
		Metadata:   ManifestMeta{Name: name, Version: version},
		Resources:  resources,
	}
	if err := ValidateBuilderManifest(m); err != nil {
		return nil, err
	}
	return m, nil
}

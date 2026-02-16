package adapters

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ParseMetadataYAML parses adapter metadata from YAML.
func ParseMetadataYAML(data []byte) (*AdapterMetadata, error) {
	var meta AdapterMetadata
	if err := yaml.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("failed to parse adapter metadata: %w", err)
	}
	return &meta, nil
}

// ScanLocalAdapters scans a directory for adapter metadata YAML files.
func ScanLocalAdapters(dir string) ([]AdapterMetadata, error) {
	var results []AdapterMetadata

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if filepath.Base(path) != "adapter.yaml" && filepath.Base(path) != "adapter.yml" {
			return nil
		}

		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read %s: %w", path, err)
		}

		meta, err := ParseMetadataYAML(data)
		if err != nil {
			return fmt.Errorf("failed to parse %s: %w", path, err)
		}
		if meta.Source == "" {
			meta.Source = filepath.Dir(path)
		}
		results = append(results, *meta)
		return nil
	})

	return results, err
}

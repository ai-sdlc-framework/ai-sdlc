package adapters

import (
	"fmt"
	"sync"
)

// AdapterMetadata describes an adapter's identity and capabilities.
type AdapterMetadata struct {
	Name      string   `json:"name" yaml:"name"`
	Interface string   `json:"interface" yaml:"interface"`
	Version   string   `json:"version" yaml:"version"`
	Source    string   `json:"source,omitempty" yaml:"source,omitempty"`
	Tags      []string `json:"tags,omitempty" yaml:"tags,omitempty"`
}

// AdapterFactory is a function that creates an adapter instance.
type AdapterFactory func(config map[string]interface{}) (interface{}, error)

type registryEntry struct {
	metadata AdapterMetadata
	factory  AdapterFactory
}

// AdapterRegistry manages adapter registration and lookup.
type AdapterRegistry struct {
	mu       sync.RWMutex
	adapters map[string]*registryEntry // key: "interface:type"
}

// NewAdapterRegistry creates a new adapter registry.
func NewAdapterRegistry() *AdapterRegistry {
	return &AdapterRegistry{
		adapters: make(map[string]*registryEntry),
	}
}

func registryKey(iface, adapterType string) string {
	return iface + ":" + adapterType
}

// Register adds an adapter to the registry.
func (r *AdapterRegistry) Register(meta AdapterMetadata, factory AdapterFactory) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if err := ValidateAdapterMetadata(&meta); err != nil {
		return err
	}

	key := registryKey(meta.Interface, meta.Name)
	r.adapters[key] = &registryEntry{metadata: meta, factory: factory}
	return nil
}

// Get retrieves an adapter factory by interface and type.
func (r *AdapterRegistry) Get(iface, adapterType string) (AdapterFactory, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	key := registryKey(iface, adapterType)
	entry, ok := r.adapters[key]
	if !ok {
		return nil, fmt.Errorf("adapter not found: %s", key)
	}
	return entry.factory, nil
}

// List returns all registered adapter metadata.
func (r *AdapterRegistry) List() []AdapterMetadata {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var result []AdapterMetadata
	for _, entry := range r.adapters {
		result = append(result, entry.metadata)
	}
	return result
}

// ListByInterface returns adapter metadata for a specific interface.
func (r *AdapterRegistry) ListByInterface(iface string) []AdapterMetadata {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var result []AdapterMetadata
	for _, entry := range r.adapters {
		if entry.metadata.Interface == iface {
			result = append(result, entry.metadata)
		}
	}
	return result
}

// ValidateAdapterMetadata checks required fields.
func ValidateAdapterMetadata(meta *AdapterMetadata) error {
	if meta.Name == "" {
		return fmt.Errorf("adapter name is required")
	}
	if meta.Interface == "" {
		return fmt.Errorf("adapter interface is required")
	}
	if meta.Version == "" {
		return fmt.Errorf("adapter version is required")
	}
	return nil
}

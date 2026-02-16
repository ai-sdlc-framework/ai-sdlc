package reconciler

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// ResourceFingerprint computes a SHA-256 fingerprint of a resource's spec.
func ResourceFingerprint(resource core.AnyResource) (string, error) {
	data, err := json.Marshal(resource)
	if err != nil {
		return "", fmt.Errorf("failed to marshal resource: %w", err)
	}
	h := sha256.Sum256(data)
	return fmt.Sprintf("%x", h), nil
}

// ResourceCache tracks resource fingerprints for change detection.
type ResourceCache struct {
	mu           sync.RWMutex
	fingerprints map[string]string // key: "kind/name" -> fingerprint
}

// NewResourceCache creates a new resource cache.
func NewResourceCache() *ResourceCache {
	return &ResourceCache{fingerprints: make(map[string]string)}
}

func cacheKey(resource core.AnyResource) string {
	return string(resource.GetKind()) + "/" + resource.GetMetadata().Name
}

// HasSpecChanged returns true if the resource spec has changed since last check.
func (c *ResourceCache) HasSpecChanged(resource core.AnyResource) (bool, error) {
	fp, err := ResourceFingerprint(resource)
	if err != nil {
		return false, err
	}

	key := cacheKey(resource)

	c.mu.RLock()
	prev, exists := c.fingerprints[key]
	c.mu.RUnlock()

	if !exists || prev != fp {
		c.mu.Lock()
		c.fingerprints[key] = fp
		c.mu.Unlock()
		return true, nil
	}
	return false, nil
}

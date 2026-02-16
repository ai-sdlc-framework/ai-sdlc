package adapters

import (
	"fmt"
	"os"
	"strings"
)

// ResolveSecret resolves a secret reference from the environment.
// Supports kebab-case to UPPER_SNAKE_CASE conversion.
func ResolveSecret(name string) (string, error) {
	envKey := strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
	val := os.Getenv(envKey)
	if val != "" {
		return val, nil
	}
	// Try with a prefix
	val = os.Getenv("AI_SDLC_" + envKey)
	if val != "" {
		return val, nil
	}
	return "", fmt.Errorf("secret %q not found (tried %s and AI_SDLC_%s)", name, envKey, envKey)
}

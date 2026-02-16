package security

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// EnvSecretStore resolves secrets from environment variables.
// Secret names in kebab-case are converted to UPPER_SNAKE_CASE.
type EnvSecretStore struct {
	prefix string
}

// NewEnvSecretStore creates a new EnvSecretStore with an optional prefix.
func NewEnvSecretStore(prefix string) *EnvSecretStore {
	return &EnvSecretStore{prefix: prefix}
}

func (s *EnvSecretStore) envKey(name string) string {
	key := strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
	if s.prefix != "" {
		return s.prefix + "_" + key
	}
	return key
}

func (s *EnvSecretStore) GetSecret(ctx context.Context, name string) (string, error) {
	key := s.envKey(name)
	val := os.Getenv(key)
	if val == "" {
		return "", fmt.Errorf("environment variable %s not set", key)
	}
	return val, nil
}

func (s *EnvSecretStore) SetSecret(ctx context.Context, name, value string) error {
	return os.Setenv(s.envKey(name), value)
}

func (s *EnvSecretStore) DeleteSecret(ctx context.Context, name string) error {
	return os.Unsetenv(s.envKey(name))
}

func (s *EnvSecretStore) ListSecrets(ctx context.Context) ([]string, error) {
	return nil, fmt.Errorf("listing environment secrets is not supported")
}

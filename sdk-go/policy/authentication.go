package policy

import (
	"context"
	"fmt"
)

// AuthIdentity represents an authenticated identity.
type AuthIdentity struct {
	Subject string            `json:"subject"`
	Roles   []string          `json:"roles,omitempty"`
	Claims  map[string]string `json:"claims,omitempty"`
}

// Authenticator validates credentials and returns an identity.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*AuthIdentity, error)
}

type tokenAuthenticator struct {
	tokens map[string]*AuthIdentity
}

// NewTokenAuthenticator creates an authenticator that validates against a token map.
func NewTokenAuthenticator(tokens map[string]*AuthIdentity) Authenticator {
	return &tokenAuthenticator{tokens: tokens}
}

func (a *tokenAuthenticator) Authenticate(ctx context.Context, token string) (*AuthIdentity, error) {
	id, ok := a.tokens[token]
	if !ok {
		return nil, fmt.Errorf("invalid token")
	}
	return id, nil
}

type alwaysAuthenticator struct {
	identity *AuthIdentity
}

// NewAlwaysAuthenticator creates an authenticator that always succeeds.
func NewAlwaysAuthenticator(identity *AuthIdentity) Authenticator {
	return &alwaysAuthenticator{identity: identity}
}

func (a *alwaysAuthenticator) Authenticate(ctx context.Context, token string) (*AuthIdentity, error) {
	return a.identity, nil
}

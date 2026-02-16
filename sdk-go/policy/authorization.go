package policy

import (
	"context"
	"fmt"
)

// AuthorizationContext contains the context for an authorization decision.
type AuthorizationContext struct {
	Subject    string            `json:"subject"`
	Action     string            `json:"action"`
	Resource   string            `json:"resource"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

// AuthorizationResult is the outcome of an authorization check.
type AuthorizationResult struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

// AuthorizationHook is a function that makes authorization decisions.
type AuthorizationHook func(ctx context.Context, ac *AuthorizationContext) (*AuthorizationResult, error)

// Authorize runs authorization hooks in order; the first denial stops evaluation.
func Authorize(ctx context.Context, ac *AuthorizationContext, hooks ...AuthorizationHook) (*AuthorizationResult, error) {
	for _, hook := range hooks {
		result, err := hook(ctx, ac)
		if err != nil {
			return nil, fmt.Errorf("authorization hook error: %w", err)
		}
		if !result.Allowed {
			return result, nil
		}
	}
	return &AuthorizationResult{Allowed: true, Reason: "all hooks passed"}, nil
}

// CheckPermission is a convenience function for a single authorization check.
func CheckPermission(ctx context.Context, subject, action, resource string, hooks ...AuthorizationHook) (bool, error) {
	ac := &AuthorizationContext{
		Subject:  subject,
		Action:   action,
		Resource: resource,
	}
	result, err := Authorize(ctx, ac, hooks...)
	if err != nil {
		return false, err
	}
	return result.Allowed, nil
}

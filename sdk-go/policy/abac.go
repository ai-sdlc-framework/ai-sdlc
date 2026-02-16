package policy

import (
	"context"
)

// ABACRule defines a single attribute-based access control rule.
type ABACRule struct {
	Subject    string `json:"subject,omitempty"`
	Action     string `json:"action,omitempty"`
	Resource   string `json:"resource,omitempty"`
	Conditions map[string]string `json:"conditions,omitempty"`
	Effect     string `json:"effect"` // "allow" or "deny"
}

// ABACPolicy defines a set of ABAC rules.
type ABACPolicy struct {
	Rules []ABACRule `json:"rules"`
}

// NewABACAuthorizationHook creates an AuthorizationHook from an ABAC policy.
func NewABACAuthorizationHook(policy *ABACPolicy) AuthorizationHook {
	return func(ctx context.Context, ac *AuthorizationContext) (*AuthorizationResult, error) {
		for _, rule := range policy.Rules {
			if matchesABAC(&rule, ac) {
				if rule.Effect == "deny" {
					return &AuthorizationResult{
						Allowed: false,
						Reason:  "denied by ABAC policy",
					}, nil
				}
				return &AuthorizationResult{
					Allowed: true,
					Reason:  "allowed by ABAC policy",
				}, nil
			}
		}
		// Default deny
		return &AuthorizationResult{
			Allowed: false,
			Reason:  "no matching ABAC rule",
		}, nil
	}
}

func matchesABAC(rule *ABACRule, ac *AuthorizationContext) bool {
	if rule.Subject != "" && rule.Subject != "*" && rule.Subject != ac.Subject {
		return false
	}
	if rule.Action != "" && rule.Action != "*" && rule.Action != ac.Action {
		return false
	}
	if rule.Resource != "" && rule.Resource != "*" && rule.Resource != ac.Resource {
		return false
	}
	for k, v := range rule.Conditions {
		if ac.Attributes == nil {
			return false
		}
		if ac.Attributes[k] != v {
			return false
		}
	}
	return true
}

package policy

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AdmissionRequest is a request to admit a resource.
type AdmissionRequest struct {
	Resource  core.AnyResource
	Identity  *AuthIdentity
	Operation string // "create", "update", "delete"
}

// AdmissionResponse is the result of an admission evaluation.
type AdmissionResponse struct {
	Allowed  bool     `json:"allowed"`
	Reasons  []string `json:"reasons,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// AdmissionPipeline chains admission checks: authentication, authorization, validation, mutation.
type AdmissionPipeline struct {
	authenticator  Authenticator
	authHooks      []AuthorizationHook
	validators     []func(core.AnyResource) error
	mutatingGates  []MutatingGate
}

// NewAdmissionPipeline creates a new admission pipeline.
func NewAdmissionPipeline() *AdmissionPipeline {
	return &AdmissionPipeline{}
}

func (p *AdmissionPipeline) WithAuthenticator(a Authenticator) *AdmissionPipeline {
	p.authenticator = a
	return p
}

func (p *AdmissionPipeline) WithAuthorizationHooks(hooks ...AuthorizationHook) *AdmissionPipeline {
	p.authHooks = append(p.authHooks, hooks...)
	return p
}

func (p *AdmissionPipeline) WithValidators(validators ...func(core.AnyResource) error) *AdmissionPipeline {
	p.validators = append(p.validators, validators...)
	return p
}

func (p *AdmissionPipeline) WithMutatingGates(gates ...MutatingGate) *AdmissionPipeline {
	p.mutatingGates = append(p.mutatingGates, gates...)
	return p
}

// AdmitResource runs the full admission pipeline.
func (p *AdmissionPipeline) AdmitResource(ctx context.Context, req *AdmissionRequest) *AdmissionResponse {
	resp := &AdmissionResponse{Allowed: true}

	// Authorization
	if len(p.authHooks) > 0 && req.Identity != nil {
		ac := &AuthorizationContext{
			Subject:  req.Identity.Subject,
			Action:   req.Operation,
			Resource: string(req.Resource.GetKind()),
		}
		result, err := Authorize(ctx, ac, p.authHooks...)
		if err != nil {
			resp.Allowed = false
			resp.Reasons = append(resp.Reasons, fmt.Sprintf("authorization error: %v", err))
			return resp
		}
		if !result.Allowed {
			resp.Allowed = false
			resp.Reasons = append(resp.Reasons, fmt.Sprintf("denied: %s", result.Reason))
			return resp
		}
	}

	// Validation
	for _, v := range p.validators {
		if err := v(req.Resource); err != nil {
			resp.Allowed = false
			resp.Reasons = append(resp.Reasons, err.Error())
		}
	}

	if !resp.Allowed {
		return resp
	}

	// Mutation
	for _, g := range p.mutatingGates {
		if err := g.Mutate(req.Resource); err != nil {
			resp.Warnings = append(resp.Warnings, fmt.Sprintf("mutation warning: %v", err))
		}
	}

	return resp
}

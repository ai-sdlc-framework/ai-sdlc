package reconciler

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AutonomyReconciler reconciles AutonomyPolicy resources.
type AutonomyReconciler struct {
	policy   *core.AutonomyPolicy
	cache    *ResourceCache
	onUpdate func(context.Context, *core.AutonomyPolicy) error
}

// NewAutonomyReconciler creates a reconciler for an AutonomyPolicy resource.
func NewAutonomyReconciler(policy *core.AutonomyPolicy, onUpdate func(context.Context, *core.AutonomyPolicy) error) *AutonomyReconciler {
	return &AutonomyReconciler{
		policy:   policy,
		cache:    NewResourceCache(),
		onUpdate: onUpdate,
	}
}

func (r *AutonomyReconciler) Reconcile(ctx context.Context) (*ReconcileResult, error) {
	changed, err := r.cache.HasSpecChanged(r.policy)
	if err != nil {
		return nil, fmt.Errorf("autonomy policy fingerprint error: %w", err)
	}
	if !changed {
		return &ReconcileResult{Requeue: false}, nil
	}
	if r.onUpdate != nil {
		if err := r.onUpdate(ctx, r.policy); err != nil {
			return &ReconcileResult{Requeue: true}, err
		}
	}
	return &ReconcileResult{Requeue: false}, nil
}

// CreateAutonomyReconciler creates a ReconcilerFn for an autonomy policy.
func CreateAutonomyReconciler(policy *core.AutonomyPolicy, onUpdate func(context.Context, *core.AutonomyPolicy) error) ReconcilerFn {
	r := NewAutonomyReconciler(policy, onUpdate)
	return r.Reconcile
}

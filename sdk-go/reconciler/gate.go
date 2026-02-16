package reconciler

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// GateReconciler reconciles QualityGate resources.
type GateReconciler struct {
	gate     *core.QualityGate
	cache    *ResourceCache
	onUpdate func(context.Context, *core.QualityGate) error
}

// NewGateReconciler creates a reconciler for a QualityGate resource.
func NewGateReconciler(gate *core.QualityGate, onUpdate func(context.Context, *core.QualityGate) error) *GateReconciler {
	return &GateReconciler{
		gate:     gate,
		cache:    NewResourceCache(),
		onUpdate: onUpdate,
	}
}

func (r *GateReconciler) Reconcile(ctx context.Context) (*ReconcileResult, error) {
	changed, err := r.cache.HasSpecChanged(r.gate)
	if err != nil {
		return nil, fmt.Errorf("gate fingerprint error: %w", err)
	}
	if !changed {
		return &ReconcileResult{Requeue: false}, nil
	}
	if r.onUpdate != nil {
		if err := r.onUpdate(ctx, r.gate); err != nil {
			return &ReconcileResult{Requeue: true}, err
		}
	}
	return &ReconcileResult{Requeue: false}, nil
}

// CreateGateReconciler creates a ReconcilerFn for a quality gate.
func CreateGateReconciler(gate *core.QualityGate, onUpdate func(context.Context, *core.QualityGate) error) ReconcilerFn {
	r := NewGateReconciler(gate, onUpdate)
	return r.Reconcile
}

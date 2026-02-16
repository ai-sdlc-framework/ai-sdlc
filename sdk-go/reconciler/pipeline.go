package reconciler

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// PipelineReconciler reconciles Pipeline resources.
type PipelineReconciler struct {
	pipeline *core.Pipeline
	cache    *ResourceCache
	onUpdate func(context.Context, *core.Pipeline) error
}

// NewPipelineReconciler creates a reconciler for a Pipeline resource.
func NewPipelineReconciler(pipeline *core.Pipeline, onUpdate func(context.Context, *core.Pipeline) error) *PipelineReconciler {
	return &PipelineReconciler{
		pipeline: pipeline,
		cache:    NewResourceCache(),
		onUpdate: onUpdate,
	}
}

// Reconcile performs a single reconciliation cycle.
func (r *PipelineReconciler) Reconcile(ctx context.Context) (*ReconcileResult, error) {
	changed, err := r.cache.HasSpecChanged(r.pipeline)
	if err != nil {
		return nil, fmt.Errorf("pipeline fingerprint error: %w", err)
	}

	if !changed {
		return &ReconcileResult{Requeue: false}, nil
	}

	if r.onUpdate != nil {
		if err := r.onUpdate(ctx, r.pipeline); err != nil {
			return &ReconcileResult{Requeue: true}, err
		}
	}

	return &ReconcileResult{Requeue: false}, nil
}

// CreatePipelineReconciler creates a ReconcilerFn for a pipeline.
func CreatePipelineReconciler(pipeline *core.Pipeline, onUpdate func(context.Context, *core.Pipeline) error) ReconcilerFn {
	r := NewPipelineReconciler(pipeline, onUpdate)
	return r.Reconcile
}

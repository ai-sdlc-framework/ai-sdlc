// Package reconciler provides a reconciliation loop for continuous state management.
package reconciler

import (
	"context"
	"time"
)

// ReconcileResult is the outcome of a reconciliation cycle.
type ReconcileResult struct {
	Requeue      bool          `json:"requeue"`
	RequeueAfter time.Duration `json:"requeueAfter,omitempty"`
	Error        error         `json:"-"`
}

// ReconcilerFn is a function that performs reconciliation.
type ReconcilerFn func(ctx context.Context) (*ReconcileResult, error)

// ReconcilerConfig configures a reconciler loop.
type ReconcilerConfig struct {
	Interval     time.Duration
	MaxRetries   int
	RetryBackoff time.Duration
}

// DefaultConfig returns the default reconciler configuration.
func DefaultConfig() *ReconcilerConfig {
	return &ReconcilerConfig{
		Interval:     30 * time.Second,
		MaxRetries:   3,
		RetryBackoff: 5 * time.Second,
	}
}

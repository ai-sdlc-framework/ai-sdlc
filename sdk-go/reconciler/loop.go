package reconciler

import (
	"context"
	"sync"
	"time"
)

// ReconcilerLoop runs a reconciler function on a periodic interval.
type ReconcilerLoop struct {
	fn       ReconcilerFn
	config   *ReconcilerConfig
	mu       sync.Mutex
	running  bool
	cancelFn context.CancelFunc
}

// NewReconcilerLoop creates a new reconciler loop.
func NewReconcilerLoop(fn ReconcilerFn, config *ReconcilerConfig) *ReconcilerLoop {
	if config == nil {
		config = DefaultConfig()
	}
	return &ReconcilerLoop{fn: fn, config: config}
}

// Start begins the reconciliation loop in a goroutine.
func (l *ReconcilerLoop) Start(ctx context.Context) {
	l.mu.Lock()
	if l.running {
		l.mu.Unlock()
		return
	}
	l.running = true
	ctx, l.cancelFn = context.WithCancel(ctx)
	l.mu.Unlock()

	go l.run(ctx)
}

// Stop cancels the reconciliation loop.
func (l *ReconcilerLoop) Stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cancelFn != nil {
		l.cancelFn()
	}
	l.running = false
}

// IsRunning returns whether the loop is currently active.
func (l *ReconcilerLoop) IsRunning() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.running
}

func (l *ReconcilerLoop) run(ctx context.Context) {
	defer func() {
		l.mu.Lock()
		l.running = false
		l.mu.Unlock()
	}()

	ticker := time.NewTicker(l.config.Interval)
	defer ticker.Stop()

	// Run immediately on start
	l.reconcileWithRetry(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			l.reconcileWithRetry(ctx)
		}
	}
}

func (l *ReconcilerLoop) reconcileWithRetry(ctx context.Context) {
	for attempt := 0; attempt <= l.config.MaxRetries; attempt++ {
		result, err := l.fn(ctx)
		if err == nil && (result == nil || result.Error == nil) {
			if result != nil && result.Requeue && result.RequeueAfter > 0 {
				time.Sleep(result.RequeueAfter)
				continue
			}
			return
		}

		if attempt < l.config.MaxRetries {
			select {
			case <-ctx.Done():
				return
			case <-time.After(l.config.RetryBackoff * time.Duration(attempt+1)):
			}
		}
	}
}

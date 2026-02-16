package adapters

import (
	"context"
	"sync"
)

type inProcessEventBus struct {
	mu       sync.RWMutex
	handlers map[string][]EventHandler
	nextID   int
}

// NewInProcessEventBus creates an in-process event bus.
func NewInProcessEventBus() EventBus {
	return &inProcessEventBus{
		handlers: make(map[string][]EventHandler),
	}
}

func (b *inProcessEventBus) Publish(ctx context.Context, event *Event) error {
	b.mu.RLock()
	handlers := b.handlers[event.Type]
	allHandlers := b.handlers["*"]
	b.mu.RUnlock()

	for _, h := range handlers {
		if err := h(ctx, event); err != nil {
			return err
		}
	}
	for _, h := range allHandlers {
		if err := h(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func (b *inProcessEventBus) Subscribe(eventType string, handler EventHandler) (func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.handlers[eventType] = append(b.handlers[eventType], handler)
	idx := len(b.handlers[eventType]) - 1
	et := eventType

	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if idx < len(b.handlers[et]) {
			b.handlers[et] = append(b.handlers[et][:idx], b.handlers[et][idx+1:]...)
		}
	}, nil
}

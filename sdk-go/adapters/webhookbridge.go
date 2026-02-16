package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// WebhookBridge converts HTTP webhook requests into EventBus events.
type WebhookBridge struct {
	bus EventBus
}

// NewWebhookBridge creates a webhook bridge for the given event bus.
func NewWebhookBridge(bus EventBus) *WebhookBridge {
	return &WebhookBridge{bus: bus}
}

// HandleWebhook is an HTTP handler that publishes webhook payloads to the event bus.
func (b *WebhookBridge) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, fmt.Sprintf("invalid payload: %v", err), http.StatusBadRequest)
		return
	}

	eventType, _ := payload["type"].(string)
	if eventType == "" {
		eventType = r.Header.Get("X-Event-Type")
	}
	if eventType == "" {
		eventType = "webhook"
	}

	event := &Event{
		Type:   eventType,
		Source: "webhook",
		Data:   payload,
	}

	if err := b.bus.Publish(r.Context(), event); err != nil {
		http.Error(w, fmt.Sprintf("publish error: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Handler returns the http.HandlerFunc for use with standard routers.
func (b *WebhookBridge) Handler() http.HandlerFunc {
	return b.HandleWebhook
}

// PublishEvent is a convenience method for programmatic event publishing.
func (b *WebhookBridge) PublishEvent(ctx context.Context, eventType, source string, data map[string]interface{}) error {
	return b.bus.Publish(ctx, &Event{Type: eventType, Source: source, Data: data})
}

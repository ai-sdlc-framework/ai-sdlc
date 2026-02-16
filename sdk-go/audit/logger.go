package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

type auditLog struct {
	mu           sync.Mutex
	sinks        []AuditSink
	entries      []*AuditEntry
	previousHash string
	counter      int
}

// NewAuditLog creates a new audit log that writes to the given sinks.
func NewAuditLog(sinks ...AuditSink) AuditLog {
	return &auditLog{
		sinks:        sinks,
		previousHash: "genesis",
	}
}

func (a *auditLog) Log(action, resourceKind, resourceName, actor, outcome string, details map[string]interface{}) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.counter++
	entry := &AuditEntry{
		ID:           fmt.Sprintf("audit-%d", a.counter),
		Timestamp:    time.Now().UTC().Format(time.RFC3339),
		Action:       action,
		ResourceKind: resourceKind,
		ResourceName: resourceName,
		Actor:        actor,
		Outcome:      outcome,
		Details:      details,
		PreviousHash: a.previousHash,
	}
	entry.Hash = ComputeEntryHash(entry)
	a.previousHash = entry.Hash
	a.entries = append(a.entries, entry)

	for _, sink := range a.sinks {
		if err := sink.Write(entry); err != nil {
			return fmt.Errorf("audit sink write failed: %w", err)
		}
	}
	return nil
}

func (a *auditLog) Query(filter *AuditFilter) ([]*AuditEntry, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var results []*AuditEntry
	for _, e := range a.entries {
		if matchesFilter(e, filter) {
			results = append(results, e)
		}
	}
	if filter != nil && filter.Limit > 0 && len(results) > filter.Limit {
		results = results[len(results)-filter.Limit:]
	}
	return results, nil
}

func (a *auditLog) Verify() (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	prev := "genesis"
	for _, e := range a.entries {
		if e.PreviousHash != prev {
			return false, nil
		}
		expected := ComputeEntryHash(e)
		if e.Hash != expected {
			return false, nil
		}
		prev = e.Hash
	}
	return true, nil
}

func matchesFilter(e *AuditEntry, f *AuditFilter) bool {
	if f == nil {
		return true
	}
	if f.Action != "" && e.Action != f.Action {
		return false
	}
	if f.ResourceKind != "" && e.ResourceKind != f.ResourceKind {
		return false
	}
	if f.ResourceName != "" && e.ResourceName != f.ResourceName {
		return false
	}
	if f.Actor != "" && e.Actor != f.Actor {
		return false
	}
	if f.Since != nil {
		ts, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil || ts.Before(*f.Since) {
			return false
		}
	}
	if f.Until != nil {
		ts, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil || ts.After(*f.Until) {
			return false
		}
	}
	return true
}

// ComputeEntryHash computes the SHA-256 hash for an audit entry (excluding the Hash field).
func ComputeEntryHash(entry *AuditEntry) string {
	data := map[string]interface{}{
		"id":           entry.ID,
		"timestamp":    entry.Timestamp,
		"action":       entry.Action,
		"resourceKind": entry.ResourceKind,
		"resourceName": entry.ResourceName,
		"actor":        entry.Actor,
		"outcome":      entry.Outcome,
		"details":      entry.Details,
		"previousHash": entry.PreviousHash,
	}
	raw, _ := json.Marshal(data)
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

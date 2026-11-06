package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// SchemaVersion is the current audit entry schema version (RFC 8785 JCS hashing).
const SchemaVersion = "2"

// TimestampLayout is RFC 3339 UTC with millisecond precision.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

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
	}
}

func (a *auditLog) Log(action, resourceKind, resourceName, actor, outcome string, details map[string]interface{}) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.counter++
	entry := &AuditEntry{
		SchemaVersion: SchemaVersion,
		ID:            fmt.Sprintf("audit-%d", a.counter),
		Timestamp:     time.Now().UTC().Format(TimestampLayout),
		Action:        action,
		ResourceKind:  resourceKind,
		ResourceName:  resourceName,
		Resource:      resourceKind + "/" + resourceName,
		Actor:         actor,
		Outcome:       outcome,
		Decision:      outcome,
		Details:       details,
		PreviousHash:  a.previousHash,
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

	return VerifyEntries(a.entries), nil
}

// VerifyEntries walks a hash chain and recomputes every entry hash. It handles
// both schema versions: a legacy entry (empty SchemaVersion) starts from the
// "genesis" sentinel, a v2 entry starts from an absent previousHash.
func VerifyEntries(entries []*AuditEntry) bool {
	prev := ""
	for i, e := range entries {
		want := prev
		if i == 0 && e.SchemaVersion != SchemaVersion {
			want = "genesis"
		}
		if e.PreviousHash != want {
			return false
		}
		if e.Hash != ComputeEntryHash(e) {
			return false
		}
		prev = e.Hash
	}
	return true
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
	if entry.SchemaVersion == SchemaVersion {
		data := map[string]interface{}{
			"schemaVersion": SchemaVersion,
			"id":            entry.ID,
			"timestamp":     entry.Timestamp,
			"actor":         entry.Actor,
			"action":        entry.Action,
			"resource":      entry.Resource,
			"decision":      entry.Decision,
		}
		if entry.Policy != "" {
			data["policy"] = entry.Policy
		}
		if entry.Details != nil {
			data["details"] = entry.Details
		}
		if entry.PreviousHash != "" {
			data["previousHash"] = entry.PreviousHash
		}
		h := sha256.Sum256([]byte(canonicalizeValue(data)))
		return hex.EncodeToString(h[:])
	}
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

// canonicalizeValue serializes a value per RFC 8785. Values are first
// round-tripped through encoding/json so structs, ints and maps normalize to
// float64/string/bool/nil/[]any/map[string]any.
func canonicalizeValue(v interface{}) string {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("audit: cannot canonicalize value: %v", err))
	}
	var generic interface{}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&generic); err != nil {
		panic(fmt.Sprintf("audit: cannot canonicalize value: %v", err))
	}
	var sb strings.Builder
	writeCanonical(&sb, generic)
	return sb.String()
}

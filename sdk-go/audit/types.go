// Package audit provides audit logging with hash-chained entries.
package audit

import "time"

// AuditEntry represents a single audit log entry.
type AuditEntry struct {
	ID           string                 `json:"id"`
	Timestamp    string                 `json:"timestamp"`
	Action       string                 `json:"action"`
	ResourceKind string                 `json:"resourceKind"`
	ResourceName string                 `json:"resourceName"`
	Actor        string                 `json:"actor"`
	Outcome      string                 `json:"outcome"`
	Details      map[string]interface{} `json:"details,omitempty"`
	Hash         string                 `json:"hash"`
	PreviousHash string                 `json:"previousHash"`
}

// AuditFilter defines criteria for querying audit entries.
type AuditFilter struct {
	Action       string
	ResourceKind string
	ResourceName string
	Actor        string
	Since        *time.Time
	Until        *time.Time
	Limit        int
}

// AuditSink defines the interface for writing audit entries.
type AuditSink interface {
	Write(entry *AuditEntry) error
	Close() error
}

// AuditLog defines the interface for the full audit log system.
type AuditLog interface {
	Log(action, resourceKind, resourceName, actor, outcome string, details map[string]interface{}) error
	Query(filter *AuditFilter) ([]*AuditEntry, error)
	Verify() (bool, error)
}

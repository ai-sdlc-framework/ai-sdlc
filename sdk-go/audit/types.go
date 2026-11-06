// Package audit provides audit logging with hash-chained entries.
package audit

import "time"

// AuditEntry represents a single audit log entry.
//
// Entries with SchemaVersion "2" use the shared cross-SDK schema (Resource,
// Decision, Policy) and are hashed over their RFC 8785 canonical form. Entries
// with an empty SchemaVersion are legacy and keep the original hash rule.
type AuditEntry struct {
	SchemaVersion string                 `json:"schemaVersion,omitempty"`
	ID            string                 `json:"id"`
	Timestamp     string                 `json:"timestamp"`
	Action        string                 `json:"action"`
	ResourceKind  string                 `json:"resourceKind,omitempty"`
	ResourceName  string                 `json:"resourceName,omitempty"`
	Resource      string                 `json:"resource,omitempty"`
	Actor         string                 `json:"actor"`
	Outcome       string                 `json:"outcome,omitempty"`
	Decision      string                 `json:"decision,omitempty"`
	Policy        string                 `json:"policy,omitempty"`
	Details       map[string]interface{} `json:"details"`
	Hash          string                 `json:"hash"`
	PreviousHash  string                 `json:"previousHash,omitempty"`
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

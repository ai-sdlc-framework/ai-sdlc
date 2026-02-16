package audit

import "sync"

// InMemoryAuditSink stores audit entries in memory.
type InMemoryAuditSink struct {
	mu      sync.Mutex
	Entries []*AuditEntry
}

// NewInMemoryAuditSink creates a new in-memory audit sink.
func NewInMemoryAuditSink() *InMemoryAuditSink {
	return &InMemoryAuditSink{}
}

func (s *InMemoryAuditSink) Write(entry *AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Entries = append(s.Entries, entry)
	return nil
}

func (s *InMemoryAuditSink) Close() error { return nil }

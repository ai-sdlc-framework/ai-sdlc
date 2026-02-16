// Package memory provides agent memory tiers.
package memory

import "time"

// MemoryTier defines the tier of a memory entry.
type MemoryTier string

const (
	TierWorking   MemoryTier = "working"
	TierShortTerm MemoryTier = "short-term"
	TierLongTerm  MemoryTier = "long-term"
	TierEpisodic  MemoryTier = "episodic"
)

// MemoryEntry is a single memory record.
type MemoryEntry struct {
	ID        string                 `json:"id"`
	Tier      MemoryTier             `json:"tier"`
	Key       string                 `json:"key"`
	Value     interface{}            `json:"value"`
	Metadata  map[string]string      `json:"metadata,omitempty"`
	CreatedAt time.Time              `json:"createdAt"`
	ExpiresAt *time.Time             `json:"expiresAt,omitempty"`
}

// WorkingMemory is a short-lived, task-scoped memory.
type WorkingMemory interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{})
	Delete(key string)
	Clear()
}

// ShortTermMemory is a session-scoped memory with TTL.
type ShortTermMemory interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{}, ttl time.Duration)
	Delete(key string)
}

// LongTermMemory is a persistent memory store.
type LongTermMemory interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{}) error
	Delete(key string) error
	Search(query string) ([]MemoryEntry, error)
}

// EpisodicMemory stores task execution episodes.
type EpisodicMemory interface {
	Record(episode *MemoryEntry) error
	GetRecent(limit int) ([]MemoryEntry, error)
	Search(query string) ([]MemoryEntry, error)
}

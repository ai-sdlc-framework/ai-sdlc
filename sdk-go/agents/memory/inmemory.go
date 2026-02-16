package memory

import (
	"strings"
	"sync"
	"time"
)

type workingMemory struct {
	mu   sync.RWMutex
	data map[string]interface{}
}

func NewWorkingMemory() WorkingMemory {
	return &workingMemory{data: make(map[string]interface{})}
}

func (m *workingMemory) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.data[key]
	return v, ok
}

func (m *workingMemory) Set(key string, value interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = value
}

func (m *workingMemory) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
}

func (m *workingMemory) Clear() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data = make(map[string]interface{})
}

type shortTermEntry struct {
	value     interface{}
	expiresAt time.Time
}

type shortTermMemory struct {
	mu   sync.RWMutex
	data map[string]*shortTermEntry
}

func NewShortTermMemory() ShortTermMemory {
	return &shortTermMemory{data: make(map[string]*shortTermEntry)}
}

func (m *shortTermMemory) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.data[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.value, true
}

func (m *shortTermMemory) Set(key string, value interface{}, ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = &shortTermEntry{value: value, expiresAt: time.Now().Add(ttl)}
}

func (m *shortTermMemory) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
}

type inMemoryLongTerm struct {
	mu      sync.RWMutex
	entries map[string]*MemoryEntry
}

func NewInMemoryLongTermMemory() LongTermMemory {
	return &inMemoryLongTerm{entries: make(map[string]*MemoryEntry)}
}

func (m *inMemoryLongTerm) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.entries[key]
	if !ok {
		return nil, false
	}
	return e.Value, true
}

func (m *inMemoryLongTerm) Set(key string, value interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.entries[key] = &MemoryEntry{
		ID:        key,
		Tier:      TierLongTerm,
		Key:       key,
		Value:     value,
		CreatedAt: time.Now(),
	}
	return nil
}

func (m *inMemoryLongTerm) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.entries, key)
	return nil
}

func (m *inMemoryLongTerm) Search(query string) ([]MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []MemoryEntry
	for _, e := range m.entries {
		if strings.Contains(e.Key, query) {
			results = append(results, *e)
		}
	}
	return results, nil
}

type inMemoryEpisodic struct {
	mu       sync.RWMutex
	episodes []MemoryEntry
}

func NewInMemoryEpisodicMemory() EpisodicMemory {
	return &inMemoryEpisodic{}
}

func (m *inMemoryEpisodic) Record(episode *MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	episode.Tier = TierEpisodic
	if episode.CreatedAt.IsZero() {
		episode.CreatedAt = time.Now()
	}
	m.episodes = append(m.episodes, *episode)
	return nil
}

func (m *inMemoryEpisodic) GetRecent(limit int) ([]MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if limit >= len(m.episodes) {
		result := make([]MemoryEntry, len(m.episodes))
		copy(result, m.episodes)
		return result, nil
	}
	start := len(m.episodes) - limit
	result := make([]MemoryEntry, limit)
	copy(result, m.episodes[start:])
	return result, nil
}

func (m *inMemoryEpisodic) Search(query string) ([]MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []MemoryEntry
	for _, e := range m.episodes {
		if strings.Contains(e.Key, query) {
			results = append(results, e)
		}
	}
	return results, nil
}

// AgentMemory bundles all memory tiers.
type AgentMemory struct {
	Working   WorkingMemory
	ShortTerm ShortTermMemory
	LongTerm  LongTermMemory
	Episodic  EpisodicMemory
}

// NewAgentMemory creates a complete in-memory agent memory system.
func NewAgentMemory() *AgentMemory {
	return &AgentMemory{
		Working:   NewWorkingMemory(),
		ShortTerm: NewShortTermMemory(),
		LongTerm:  NewInMemoryLongTermMemory(),
		Episodic:  NewInMemoryEpisodicMemory(),
	}
}

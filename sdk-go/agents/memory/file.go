package memory

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type fileLongTermMemory struct {
	mu   sync.RWMutex
	path string
	data map[string]*MemoryEntry
}

// NewFileLongTermMemory creates a file-backed long-term memory.
func NewFileLongTermMemory(path string) (LongTermMemory, error) {
	m := &fileLongTermMemory{
		path: path,
		data: make(map[string]*MemoryEntry),
	}
	if err := m.load(); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return m, nil
}

func (m *fileLongTermMemory) load() error {
	data, err := os.ReadFile(m.path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, &m.data)
}

func (m *fileLongTermMemory) save() error {
	data, err := json.MarshalIndent(m.data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.path, data, 0644)
}

func (m *fileLongTermMemory) Get(key string) (interface{}, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.data[key]
	if !ok {
		return nil, false
	}
	return e.Value, true
}

func (m *fileLongTermMemory) Set(key string, value interface{}) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = &MemoryEntry{
		ID:        key,
		Tier:      TierLongTerm,
		Key:       key,
		Value:     value,
		CreatedAt: time.Now(),
	}
	return m.save()
}

func (m *fileLongTermMemory) Delete(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return m.save()
}

func (m *fileLongTermMemory) Search(query string) ([]MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var results []MemoryEntry
	for _, e := range m.data {
		if strings.Contains(e.Key, query) {
			results = append(results, *e)
		}
	}
	return results, nil
}

type fileEpisodicMemory struct {
	mu   sync.RWMutex
	path string
}

// NewFileEpisodicMemory creates a file-backed episodic memory (JSONL append).
func NewFileEpisodicMemory(path string) EpisodicMemory {
	return &fileEpisodicMemory{path: path}
}

func (m *fileEpisodicMemory) Record(episode *MemoryEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	episode.Tier = TierEpisodic
	if episode.CreatedAt.IsZero() {
		episode.CreatedAt = time.Now()
	}

	f, err := os.OpenFile(m.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("failed to open episodic memory file: %w", err)
	}
	defer f.Close()

	data, err := json.Marshal(episode)
	if err != nil {
		return err
	}
	_, err = f.Write(append(data, '\n'))
	return err
}

func (m *fileEpisodicMemory) GetRecent(limit int) ([]MemoryEntry, error) {
	entries, err := m.readAll()
	if err != nil {
		return nil, err
	}
	if limit >= len(entries) {
		return entries, nil
	}
	return entries[len(entries)-limit:], nil
}

func (m *fileEpisodicMemory) Search(query string) ([]MemoryEntry, error) {
	entries, err := m.readAll()
	if err != nil {
		return nil, err
	}
	var results []MemoryEntry
	for _, e := range entries {
		if strings.Contains(e.Key, query) {
			results = append(results, e)
		}
	}
	return results, nil
}

func (m *fileEpisodicMemory) readAll() ([]MemoryEntry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	data, err := os.ReadFile(m.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var entries []MemoryEntry
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var entry MemoryEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

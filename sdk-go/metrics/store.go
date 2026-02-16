package metrics

import (
	"sort"
	"strings"
	"sync"
)

type inMemoryStore struct {
	mu      sync.RWMutex
	metrics map[string]map[string]float64 // metric name -> label key -> value
}

// NewMetricStore creates a new in-memory MetricStore.
func NewMetricStore() MetricStore {
	return &inMemoryStore{
		metrics: make(map[string]map[string]float64),
	}
}

func labelsKey(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(labels))
	for k, v := range labels {
		pairs = append(pairs, k+"="+v)
	}
	sort.Strings(pairs)
	return strings.Join(pairs, ",")
}

func (s *inMemoryStore) Record(name string, value float64, labels map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.metrics[name]; !ok {
		s.metrics[name] = make(map[string]float64)
	}
	s.metrics[name][labelsKey(labels)] = value
	return nil
}

func (s *inMemoryStore) Get(name string, labels map[string]string) (float64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	m, ok := s.metrics[name]
	if !ok {
		return 0, false
	}
	v, ok := m[labelsKey(labels)]
	return v, ok
}

func (s *inMemoryStore) GetAll(name string) map[string]float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	m, ok := s.metrics[name]
	if !ok {
		return nil
	}
	result := make(map[string]float64, len(m))
	for k, v := range m {
		result[k] = v
	}
	return result
}

func (s *inMemoryStore) List() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.metrics))
	for k := range s.metrics {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

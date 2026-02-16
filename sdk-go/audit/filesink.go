package audit

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// FileSink writes audit entries as JSONL to a file.
type FileSink struct {
	mu   sync.Mutex
	file *os.File
}

// NewFileSink creates a FileSink that appends to the given file path.
func NewFileSink(path string) (*FileSink, error) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open audit file: %w", err)
	}
	return &FileSink{file: f}, nil
}

func (s *FileSink) Write(entry *AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("failed to marshal audit entry: %w", err)
	}
	if _, err := s.file.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("failed to write audit entry: %w", err)
	}
	return nil
}

func (s *FileSink) Close() error {
	return s.file.Close()
}

// LoadEntriesFromFile reads all audit entries from a JSONL file.
func LoadEntriesFromFile(path string) ([]*AuditEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var entries []*AuditEntry
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		var entry AuditEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return nil, fmt.Errorf("failed to parse audit entry: %w", err)
		}
		entries = append(entries, &entry)
	}
	return entries, scanner.Err()
}

// VerifyFileIntegrity checks the hash chain of a JSONL audit file.
func VerifyFileIntegrity(path string) (bool, error) {
	entries, err := LoadEntriesFromFile(path)
	if err != nil {
		return false, err
	}

	prev := "genesis"
	for _, e := range entries {
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

// RotateAuditFile renames the current file and creates a new one.
func RotateAuditFile(sink *FileSink, archivePath string) error {
	sink.mu.Lock()
	defer sink.mu.Unlock()

	currentPath := sink.file.Name()
	if err := sink.file.Close(); err != nil {
		return err
	}
	if err := os.Rename(currentPath, archivePath); err != nil {
		return err
	}
	f, err := os.OpenFile(currentPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	sink.file = f
	return nil
}

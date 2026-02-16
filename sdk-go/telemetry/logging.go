package telemetry

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// LogLevel represents logging severity.
type LogLevel string

const (
	LogDebug LogLevel = "debug"
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
)

// LogEntry represents a structured log entry.
type LogEntry struct {
	Timestamp string                 `json:"timestamp"`
	Level     LogLevel               `json:"level"`
	Message   string                 `json:"message"`
	Fields    map[string]interface{} `json:"fields,omitempty"`
}

// StructuredLogger defines the interface for structured logging.
type StructuredLogger interface {
	Debug(msg string, fields map[string]interface{})
	Info(msg string, fields map[string]interface{})
	Warn(msg string, fields map[string]interface{})
	Error(msg string, fields map[string]interface{})
}

// NoOpLogger discards all log messages.
type NoOpLogger struct{}

func NewNoOpLogger() *NoOpLogger { return &NoOpLogger{} }

func (l *NoOpLogger) Debug(msg string, fields map[string]interface{}) {}
func (l *NoOpLogger) Info(msg string, fields map[string]interface{})  {}
func (l *NoOpLogger) Warn(msg string, fields map[string]interface{})  {}
func (l *NoOpLogger) Error(msg string, fields map[string]interface{}) {}

// BufferLogger stores log entries in memory for inspection.
type BufferLogger struct {
	mu      sync.Mutex
	Entries []LogEntry
}

func NewBufferLogger() *BufferLogger {
	return &BufferLogger{}
}

func (l *BufferLogger) log(level LogLevel, msg string, fields map[string]interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Entries = append(l.Entries, LogEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Level:     level,
		Message:   msg,
		Fields:    fields,
	})
}

func (l *BufferLogger) Debug(msg string, fields map[string]interface{}) { l.log(LogDebug, msg, fields) }
func (l *BufferLogger) Info(msg string, fields map[string]interface{})  { l.log(LogInfo, msg, fields) }
func (l *BufferLogger) Warn(msg string, fields map[string]interface{})  { l.log(LogWarn, msg, fields) }
func (l *BufferLogger) Error(msg string, fields map[string]interface{}) { l.log(LogError, msg, fields) }

// ConsoleLogger writes JSON log entries to an io.Writer.
type ConsoleLogger struct {
	writer io.Writer
	mu     sync.Mutex
}

func NewConsoleLogger() *ConsoleLogger {
	return &ConsoleLogger{writer: os.Stderr}
}

func NewConsoleLoggerWithWriter(w io.Writer) *ConsoleLogger {
	return &ConsoleLogger{writer: w}
}

func (l *ConsoleLogger) log(level LogLevel, msg string, fields map[string]interface{}) {
	entry := LogEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Level:     level,
		Message:   msg,
		Fields:    fields,
	}
	data, _ := json.Marshal(entry)
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintln(l.writer, string(data))
}

func (l *ConsoleLogger) Debug(msg string, fields map[string]interface{}) { l.log(LogDebug, msg, fields) }
func (l *ConsoleLogger) Info(msg string, fields map[string]interface{})  { l.log(LogInfo, msg, fields) }
func (l *ConsoleLogger) Warn(msg string, fields map[string]interface{})  { l.log(LogWarn, msg, fields) }
func (l *ConsoleLogger) Error(msg string, fields map[string]interface{}) { l.log(LogError, msg, fields) }

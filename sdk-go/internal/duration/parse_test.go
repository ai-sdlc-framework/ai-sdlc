package duration

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseShorthand(t *testing.T) {
	tests := []struct {
		input string
		want  time.Duration
	}{
		{"60s", 60 * time.Second},
		{"5m", 5 * time.Minute},
		{"2h", 2 * time.Hour},
		{"1d", 24 * time.Hour},
		{"2w", 14 * 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ParseDuration(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseISO8601(t *testing.T) {
	tests := []struct {
		input string
		want  time.Duration
	}{
		{"PT30M", 30 * time.Minute},
		{"PT1H", 1 * time.Hour},
		{"P1D", 24 * time.Hour},
		{"P1DT2H", 26 * time.Hour},
		{"PT1H30M", 90 * time.Minute},
		{"P1Y", 365 * 24 * time.Hour},
		{"P1M", 30 * 24 * time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ParseDuration(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseInvalid(t *testing.T) {
	tests := []string{
		"",
		"abc",
		"10x",
		"P",
	}

	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			_, err := ParseDuration(input)
			assert.Error(t, err)
		})
	}
}

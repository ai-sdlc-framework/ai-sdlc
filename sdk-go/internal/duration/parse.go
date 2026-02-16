// Package duration provides parsing for AI-SDLC duration strings.
package duration

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

var shorthandPattern = regexp.MustCompile(`^(\d+)([smhdw])$`)

var isoPattern = regexp.MustCompile(`^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$`)

// ParseDuration parses a duration string in shorthand (60s, 5m, 2h, 1d, 2w)
// or ISO 8601 (P1DT2H) format into a Go time.Duration.
func ParseDuration(s string) (time.Duration, error) {
	if s == "" {
		return 0, fmt.Errorf("empty duration string")
	}

	// Try shorthand first
	if m := shorthandPattern.FindStringSubmatch(s); m != nil {
		val, _ := strconv.Atoi(m[1])
		switch m[2] {
		case "s":
			return time.Duration(val) * time.Second, nil
		case "m":
			return time.Duration(val) * time.Minute, nil
		case "h":
			return time.Duration(val) * time.Hour, nil
		case "d":
			return time.Duration(val) * 24 * time.Hour, nil
		case "w":
			return time.Duration(val) * 7 * 24 * time.Hour, nil
		}
	}

	// Try ISO 8601
	if m := isoPattern.FindStringSubmatch(s); m != nil {
		var total time.Duration
		if m[1] != "" {
			v, _ := strconv.Atoi(m[1])
			total += time.Duration(v) * 365 * 24 * time.Hour // approximate year
		}
		if m[2] != "" {
			v, _ := strconv.Atoi(m[2])
			total += time.Duration(v) * 30 * 24 * time.Hour // approximate month
		}
		if m[3] != "" {
			v, _ := strconv.Atoi(m[3])
			total += time.Duration(v) * 24 * time.Hour
		}
		if m[4] != "" {
			v, _ := strconv.Atoi(m[4])
			total += time.Duration(v) * time.Hour
		}
		if m[5] != "" {
			v, _ := strconv.Atoi(m[5])
			total += time.Duration(v) * time.Minute
		}
		if m[6] != "" {
			v, _ := strconv.Atoi(m[6])
			total += time.Duration(v) * time.Second
		}
		if total == 0 {
			return 0, fmt.Errorf("invalid ISO 8601 duration: %s", s)
		}
		return total, nil
	}

	return 0, fmt.Errorf("unrecognized duration format: %s", s)
}

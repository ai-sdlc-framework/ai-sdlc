package audit

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// writeCanonical writes v (as produced by encoding/json into interface{}) in
// RFC 8785 form.
func writeCanonical(sb *strings.Builder, v interface{}) {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		sb.WriteString(strconv.FormatBool(t))
	case float64:
		sb.WriteString(formatNumber(t))
	case string:
		writeString(sb, t)
	case []interface{}:
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeCanonical(sb, e)
		}
		sb.WriteByte(']')
	case map[string]interface{}:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			a, b := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
			for x := 0; x < len(a) && x < len(b); x++ {
				if a[x] != b[x] {
					return a[x] < b[x]
				}
			}
			return len(a) < len(b)
		})
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeString(sb, k)
			sb.WriteByte(':')
			writeCanonical(sb, t[k])
		}
		sb.WriteByte('}')
	default:
		panic(fmt.Sprintf("audit: cannot canonicalize %T", v))
	}
}

// writeString escapes only what RFC 8785 requires: no HTML escaping and no
//  /  escaping, unlike encoding/json.
func writeString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// formatNumber renders a float64 in the ECMAScript shortest form.
func formatNumber(f float64) string {
	if f == 0 {
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// "d.ddde±XX": shortest round-trip digits.
	e := strconv.FormatFloat(f, 'e', -1, 64)
	mant, expStr, _ := strings.Cut(e, "e")
	exp, _ := strconv.Atoi(expStr)
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := exp + 1
	var body string
	switch {
	case k <= n && n <= 21:
		body = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		body = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		body = "0." + strings.Repeat("0", -n) + digits
	default:
		x := n - 1
		esign := "+"
		if x < 0 {
			esign = "-"
			x = -x
		}
		m := digits
		if k > 1 {
			m = digits[:1] + "." + digits[1:]
		}
		body = m + "e" + esign + strconv.Itoa(x)
	}
	return sign + body
}

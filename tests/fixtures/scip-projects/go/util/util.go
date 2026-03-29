// Package util provides helper functions.
package util

// Config holds application configuration.
type Config struct {
	Name  string
	Port  int
	Debug bool
}

// DefaultConfig returns a default configuration.
func DefaultConfig() Config {
	return Config{Name: "app", Port: 3000, Debug: false}
}

// Add returns the sum of two integers.
func Add(a, b int) int {
	return a + b
}

// StringHelper formats strings with a prefix.
type StringHelper struct {
	Prefix string
}

// Format returns the value formatted with the prefix.
func (h *StringHelper) Format(value string) string {
	return h.Prefix + ": " + value
}

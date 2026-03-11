package sample

import (
	"fmt"
	"math"
	alias "os"
)

type Shape interface {
	Area() float64
	Perimeter() float64
}

type Reader interface {
	Shape
	Read(p []byte) (int, error)
}

type Circle struct {
	Radius float64
}

type Config struct {
	Items   []Item
	Cache   map[string]Item
	Parent  *Config
}

type Item struct {
	ID int
}

type ID string

func (c Circle) Area() float64 {
	return math.Pi * c.Radius * c.Radius
}

func (c Circle) Perimeter() float64 {
	return 2 * math.Pi * c.Radius
}

func (c *Config) Reset() {
	c.Items = nil
}

func Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

func Add(a, b int) int {
	return a + b
}

func Setup() {
	var name string = "test"
	_ = name
	_ = alias.Stdout
}

func Convert(v interface{}) string {
	s := v.(string)
	return s
}

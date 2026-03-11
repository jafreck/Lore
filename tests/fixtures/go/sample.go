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

// Named return types — triggers parameter_list result branches
func SplitString(s string) (head string, tail string) {
	return "", ""
}

func (c *Circle) Bounds() (minX float64, maxX float64) {
	return -c.Radius, c.Radius
}

// Interface with method signatures that have named returns and param types
type Encoder interface {
	Encode(v interface{}) (n int, err error)
	Reset()
}

// Gin-style routes (covers route extraction branches)
func initRoutes(r Router) {
	r.GET("/users", listUsers)
	r.POST("/users", createUser)
	r.PUT(`/users/:id`, updateUser)
	r.DELETE("/users/:id", deleteUser)
	r.PATCH("/config", patchConfig)
	r.OPTIONS("/api", optionsHandler)
	r.HEAD("/status", headHandler)
	r.Any("/fallback", catchAll)
}

type Router struct{}

func (e Router) GET(path string, h func())     {}
func (e Router) POST(path string, h func())    {}
func (e Router) PUT(path string, h func())     {}
func (e Router) DELETE(path string, h func())  {}
func (e Router) PATCH(path string, h func())   {}
func (e Router) OPTIONS(path string, h func()) {}
func (e Router) HEAD(path string, h func())    {}
func (e Router) Any(path string, h func())     {}

func listUsers()      {}
func createUser()     {}
func updateUser()     {}
func deleteUser()     {}
func patchConfig()    {}
func optionsHandler() {}
func headHandler()    {}
func catchAll()       {}

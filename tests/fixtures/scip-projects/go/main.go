// Package main is the entry point.
package main

import (
	"fmt"

	"example.com/scip-fixture/util"
)

// main initializes and runs the application.
func main() {
	config := util.DefaultConfig()
	result := util.Add(config.Port, 1)
	helper := &util.StringHelper{Prefix: "App"}
	fmt.Println(helper.Format(fmt.Sprintf("running on port %d", result)))
}

// processItems computes the total length of items.
func processItems(items []string) int {
	total := 0
	for _, item := range items {
		total = util.Add(total, len(item))
	}
	return total
}

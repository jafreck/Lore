package main

type Circle struct { Radius float64 }

func (c Circle) Area() float64 { return 0 }
func (c *Circle) SetRadius(r float64) { c.Radius = r }

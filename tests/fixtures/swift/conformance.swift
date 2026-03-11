protocol Shape { func area() -> Double }
struct Circle: Shape {
var radius: Double
func area() -> Double { return 0 }
}


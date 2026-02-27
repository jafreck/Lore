import Foundation
import Darwin

protocol Shape {
    func area() -> Double
    func perimeter() -> Double
}

struct Circle: Shape {
    let radius: Double

    func area() -> Double {
        return Double.pi * radius * radius
    }

    func perimeter() -> Double {
        return 2 * Double.pi * radius
    }
}

class Rectangle: Shape {
    let width: Double
    let height: Double

    init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }

    func area() -> Double {
        return width * height
    }

    func perimeter() -> Double {
        return 2 * (width + height)
    }
}

func greet(name: String) -> String {
    return "Hello, \(name)!"
}

func add(_ a: Int, _ b: Int) -> Int {
    return a + b
}

extension Circle {
    func describe() -> String {
        return "Circle with radius \(radius)"
    }
}

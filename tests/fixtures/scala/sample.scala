import scala.math.{PI, sqrt}
import scala.collection.mutable.ArrayBuffer

def greet(name: String): String = s"Hello, $name!"

def add(a: Int, b: Int): Int = a + b

trait Shape {
  def area(): Double
  def perimeter(): Double
}

class Circle(val radius: Double) extends Shape {
  def area(): Double = PI * radius * radius
  def perimeter(): Double = 2 * PI * radius
}

object MathUtils {
  def square(x: Int): Int = x * x

  def clamp(value: Int, min: Int, max: Int): Int =
    if value < min then min
    else if value > max then max
    else value
}

val version = "1.0.0"
var counter = 0

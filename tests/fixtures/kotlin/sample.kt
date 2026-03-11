import kotlin.math.PI
import kotlin.math.sqrt

fun greet(name: String): String {
    return "Hello, $name!"
}

fun add(a: Int, b: Int): Int = a + b

interface Shape {
    fun area(): Double
    fun perimeter(): Double
}

class Circle(private val radius: Double) : Shape {
    val diameter: Double = radius * 2

    override fun area(): Double = PI * radius * radius

    override fun perimeter(): Double = 2 * PI * radius
}

object MathUtils {
    fun square(x: Int): Int = x * x
}

fun main() {
    val msg = greet("World")
    val sum = add(1, 2)
    val c = Circle(5.0)
    println(c.area())
    val x = sum as Any
    val n: Int? = null
    val items: List<String> = listOf()
}

enum class Color {
    RED, GREEN, BLUE
}

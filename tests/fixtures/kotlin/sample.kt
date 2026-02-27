import kotlin.math.PI
import kotlin.math.sqrt

fun greet(name: String): String {
    return "Hello, $name!"
}

fun add(a: Int, b: Int): Int = a + b

class Circle(private val radius: Double) {
    fun area(): Double = PI * radius * radius

    fun perimeter(): Double = 2 * PI * radius
}

interface Shape {
    fun area(): Double
    fun perimeter(): Double
}

object MathUtils {
    fun square(x: Int): Int = x * x
}

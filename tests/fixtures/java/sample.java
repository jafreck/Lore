import java.util.List;
import java.util.ArrayList;
import java.io.IOException;
import static java.lang.Math.PI;

public class Sample {
    private String name;

    public Sample(String name) {
        this.name = name;
    }

    public String greet() {
        return "Hello, " + this.name + "!";
    }

    public static int add(int a, int b) {
        return a + b;
    }
}

interface Shape {
    double area();
    double perimeter();
}

interface Describable extends Shape {
    String describe();
}

class Animal {
    void speak() {}
}

class Circle extends Animal implements Shape {
    private double radius;

    public Circle(double radius) {
        this.radius = radius;
    }

    public double area() {
        return PI * radius * radius;
    }

    public double perimeter() {
        return 2 * PI * radius;
    }

    public static void main(String[] args) {
        Sample s = new Sample("World");
        String greeting = s.greet();
        int sum = Sample.add(1, 2);
        double x = (double) sum;
        System.out.println(greeting);
        List<String> names = new ArrayList<>();
    }
}

enum Color {
    RED, GREEN, BLUE
}

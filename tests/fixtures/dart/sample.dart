import 'dart:math';
import 'package:meta/meta.dart';

class Circle {
  final double radius;

  Circle(this.radius);

  double area() => pi * radius * radius;

  double perimeter() => 2 * pi * radius;
}

int add(int a, int b) {
  return a + b;
}

String greet(String name) {
  return 'Hello, $name!';
}

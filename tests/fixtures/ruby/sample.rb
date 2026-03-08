require 'json'
require_relative 'shape'

module Geometry
  PI = Math::PI

  class Circle
    attr_reader :radius

    def initialize(radius)
      @radius = radius
    end

    def area
      PI * @radius ** 2
    end

    def perimeter
      2 * PI * @radius
    end

    def self.unit_circle
      new(1.0)
    end
  end
end

def greet(name)
  "Hello, #{name}!"
end

def add(a, b)
  a + b
end

def main
  msg = greet("World")
  total = add(1, 2)
  c = Geometry::Circle.new(5.0)
  puts c.area
end

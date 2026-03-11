use std::fmt;
use std::collections::HashMap;

pub struct Circle {
    pub radius: f64,
}

pub struct Rectangle {
    pub width: f64,
    pub height: f64,
}

pub enum Color {
    Red,
    Green,
    Blue,
}

pub trait Shape {
    fn area(&self) -> f64;
    fn perimeter(&self) -> f64;
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }

    fn perimeter(&self) -> f64 {
        2.0 * std::f64::consts::PI * self.radius
    }
}

pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn main() {
    let msg = greet("World");
    let sum = add(1, 2);
    let x = sum as f64;
    let count: i32 = 42;
    println!("{} {}", msg, sum);
    let v: Vec<i32> = Vec::new();
    let map: HashMap<String, i32> = HashMap::new();
    let opt: Option<i32> = None;
}

impl fmt::Display for Circle {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Circle(r={})", self.radius)
    }
}

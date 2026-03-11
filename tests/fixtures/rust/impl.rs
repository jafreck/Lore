struct Circle { radius: f64 }
trait Shape { fn area(&self) -> f64; }
impl Shape for Circle {
  fn area(&self) -> f64 { 0.0 }
}

#include "lore_fixture/model.hpp"

namespace lore_fixture {

int Base::compute(int value) const {
  return value;
}

int Derived::compute(int value) const {
  return LORE_CPP_BIAS(value);
}

double Derived::compute(double value) const {
  return value + 0.5;
}

int Calculator::combine(int left, int right) const {
  return left + right;
}

double Calculator::combine(double left, double right) const {
  return left + right;
}

int invoke(const Base &base, int value) {
  return base.compute(value);
}

int cpp_fast_path(int value) {
  return value + 10;
}

int cpp_safe_path(int value) {
  return value - 10;
}

} // namespace lore_fixture
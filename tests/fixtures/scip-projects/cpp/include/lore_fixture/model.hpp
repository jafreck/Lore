#ifndef LORE_FIXTURE_MODEL_HPP
#define LORE_FIXTURE_MODEL_HPP

#define LORE_CPP_BIAS(value) ((value) + 3)

namespace lore_fixture {

template <typename T>
T doubled(T value) {
  return value + value;
}

struct Packet {
  int value;
};

class Base {
public:
  virtual ~Base() = default;
  virtual int compute(int value) const;
};

class Derived final : public Base {
public:
  int compute(int value) const override;
  double compute(double value) const;
};

class Calculator {
public:
  int combine(int left, int right) const;
  double combine(double left, double right) const;
};

int invoke(const Base &base, int value);
int cpp_fast_path(int value);
int cpp_safe_path(int value);
int cpp_configured_value(int value);

} // namespace lore_fixture

#endif
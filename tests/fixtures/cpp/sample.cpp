#include <iostream>
#include <string>

class Greeter {
public:
  explicit Greeter(std::string name) : name_(std::move(name)) {}

  std::string greet() const {
    return "Hello, " + name_ + "!";
  }

private:
  std::string name_;
};

int add(int a, int b) {
  return a + b;
}

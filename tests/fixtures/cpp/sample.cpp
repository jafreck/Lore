#include <iostream>
#include <string>
#include <functional>

// ─── Macros ───────────────────────────────────────────────────────────────────
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define VERSION 42

// ─── Classes / structs ────────────────────────────────────────────────────────

class Greeter {
public:
  explicit Greeter(std::string name) : name_(std::move(name)) {}

  std::string greet() const {
    return "Hello, " + name_ + "!";
  }

private:
  std::string name_;
};

struct Callback {
  void (*on_event)(int);
};

// ─── Ordinary functions ───────────────────────────────────────────────────────

int add(int a, int b) {
  return a + b;
}

void apply(void (*fn)(int), int value) {
  (*fn)(value);
}

// ─── Runner exercising all call kinds ─────────────────────────────────────────

void handler(int x) {
  std::cout << x << std::endl;
}

void run() {
  // Direct calls
  Greeter g("World");
  std::cout << g.greet() << std::endl;
  int sum = add(1, 2);

  // Macro invocation
  int m = MAX(sum, 10);

  // Function pointer — indirect call via (*fn)(...)
  void (*fp)(int) = handler;
  (*fp)(42);

  // Function pointer passed to higher-order function
  apply(handler, 7);

  // Struct holding function pointer — indirect via field
  Callback cb;
  cb.on_event = handler;
  cb.on_event(99);

  // std::function wrapper
  std::function<void(int)> wrapped = handler;
  wrapped(5);
}

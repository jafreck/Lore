#include <iostream>
#include <string>
#include <functional>

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define VERSION 42

enum Color { RED, GREEN, BLUE };

class Base {
public:
  virtual ~Base() {}
  virtual void process() {}
};

class Greeter : public Base {
public:
  explicit Greeter(std::string name) : name_(std::move(name)) {}

  std::string greet() const {
    return "Hello, " + name_ + "!";
  }

  void process() override {
    std::cout << greet() << std::endl;
  }

private:
  std::string name_;
};

struct Callback {
  void (*on_event)(int);
};

typedef void (*HandlerFn)(int, int);

int add(int a, int b);

int add(int a, int b) {
  return a + b;
}

void apply(void (*fn)(int), int value) {
  (*fn)(value);
}

void handler(int x) {
  std::cout << x << std::endl;
}

void run() {
  Greeter g("World");
  std::cout << g.greet() << std::endl;
  int sum = add(1, 2);

  int m = MAX(sum, 10);
  auto s1 = sizeof(int);

  Base* base = &g;
  Greeter* derived = dynamic_cast<Greeter*>(base);
  Greeter* s = static_cast<Greeter*>(base);
  void* r = reinterpret_cast<void*>(base);
  const Base* cb2 = const_cast<const Base*>(base);
  int x = (int)3.14;
  auto align = alignof(int);

  std::string name = "test";

  g.process();

  void (*fp)(int) = handler;
  (*fp)(42);

  apply(handler, 7);

  Callback cb;
  cb.on_event = handler;
  cb.on_event(99);

  std::function<void(int)> wrapped = handler;
  wrapped(5);
}

template<typename... Args>
int count_args(Args... args) {
  return sizeof...(args);
}

namespace MyNamespace {
  void helper() {}
}

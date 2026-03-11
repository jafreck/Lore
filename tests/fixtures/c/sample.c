#include <stdio.h>
#include <stdlib.h>

// ─── Macros ───────────────────────────────────────────────────────────────────
#define SQUARE(x) ((x) * (x))
#define PI 3

// ─── Structs / typedefs ──────────────────────────────────────────────────────

struct Point {
  int x;
  int y;
};

typedef struct Point Point;

typedef int (*BinaryOp)(int, int);

// ─── Functions ────────────────────────────────────────────────────────────────

int add(int a, int b) {
  return a + b;
}

void print_point(Point p) {
  printf("(%d, %d)\n", p.x, p.y);
}

void apply(BinaryOp op, int a, int b) {
  int result = (*op)(a, b);
  printf("%d\n", result);
}

void run() {
  Point p = { 1, 2 };
  print_point(p);

  int sq = SQUARE(5);
  printf("%d\n", sq);

  // Function pointer (indirect call)
  BinaryOp fn = add;
  (*fn)(3, 4);

  // Higher-order function
  apply(add, 10, 20);

  // Cast expression
  void *ptr = (void *)&p;
  int val = (int)p.x;

  // sizeof expression
  size_t sz = sizeof(Point);

  // Subscript-based indirect call (function pointer array)
  BinaryOp ops[2] = { add, add };
  (ops[0])(1, 2);
}

// Function declaration (prototype)
int multiply(int a, int b);

// Enum
enum Color { RED, GREEN, BLUE };

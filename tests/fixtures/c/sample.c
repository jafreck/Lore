#include <stdio.h>
#include <stdlib.h>

struct Point {
  int x;
  int y;
};

typedef struct Point Point;

int add(int a, int b) {
  return a + b;
}

void print_point(Point p) {
  printf("(%d, %d)\n", p.x, p.y);
}

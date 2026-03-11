typedef int (*BinaryOp)(int, int);
int add(int a, int b) { return a+b; }
void run() { BinaryOp fn = add; (*fn)(3, 4); }

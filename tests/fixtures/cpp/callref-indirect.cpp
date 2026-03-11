void handler(int x) {}
void run() { void (*fp)(int) = handler; (*fp)(42); }

/* Public API header — function prototypes / forward declarations. */
#ifndef SAMPLE_H
#define SAMPLE_H

#include <stddef.h>

// ─── Macros ───────────────────────────────────────────────────────────────────
#define MAX_SIZE 1024
#define ALIGN(x, a) (((x) + (a) - 1) & ~((a) - 1))

// ─── Types ────────────────────────────────────────────────────────────────────

struct Buffer {
  void* data;
  size_t length;
  size_t capacity;
};

typedef struct Buffer Buffer;
typedef unsigned long usize;

enum Status {
  STATUS_OK,
  STATUS_ERROR,
  STATUS_PENDING,
};

// ─── Function declarations (prototypes) ───────────────────────────────────────

Buffer* buffer_create(size_t initial_capacity);
void    buffer_destroy(Buffer* buf);
int     buffer_append(Buffer* buf, const void* data, size_t len);
size_t  buffer_remaining(const Buffer* buf);

/* Variadic helper */
int buffer_printf(Buffer* buf, const char* fmt, ...);

/* Static inline declared in header */
static inline int buffer_is_empty(const Buffer* buf) {
  return buf->length == 0;
}

#endif /* SAMPLE_H */

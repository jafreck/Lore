#include "lore_fixture/api.h"

struct LoreContext {
  int value;
};

int lore_add(int left, int right) {
  return left + right;
}

LoreRecord lore_make_record(lore_id_t id, const char *label) {
  LoreRecord record = {id, label};
  return record;
}

int lore_context_value(const struct LoreContext *context) {
  return context->value;
}

/* UTF-8 prefix: café 🚀 */ int lore_unicode_value(int value) {
  return LORE_FIXTURE_SCALE(value) + LORE_FIXTURE_MAGIC;
}

int lore_fast_path(int value) {
  return lore_add(value, 1);
}

int lore_safe_path(int value) {
  return lore_add(value, -1);
}
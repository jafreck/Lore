#include "lore_fixture/api.h"

int lore_run(void) {
  LoreRecord record = lore_make_record(7, "fixture");
  return lore_add((int)record.id, lore_unicode_value(LORE_FIXTURE_MAGIC));
}
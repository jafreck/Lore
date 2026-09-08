#include "lore_fixture/api.h"

int lore_configured_value(int value) {
#if defined(LORE_FAST)
  return lore_fast_path(value);
#elif defined(LORE_SAFE)
  return lore_safe_path(value);
#else
  return value;
#endif
}
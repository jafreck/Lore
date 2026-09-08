#include "config.h"
#include "lore_fixture/api.h"

int lore_beta_value(int value) {
  return lore_add(value, LORE_MODE_TAG);
}
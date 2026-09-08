#include "lore_fixture/compat.h"
#include "lore_fixture/model.hpp"

namespace lore_fixture {

/* UTF-8 prefix: naïve 🚀 */ int cpp_run() {
  Derived derived;
  Calculator calculator;
  LegacyFlag flag(true);
  const int base = invoke(derived, doubled(4));
  return flag.enabled() ? calculator.combine(base, 2) : 0;
}

} // namespace lore_fixture
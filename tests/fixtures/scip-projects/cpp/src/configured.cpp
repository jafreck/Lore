#include "lore_fixture/model.hpp"

namespace lore_fixture {

int cpp_configured_value(int value) {
#if defined(LORE_CPP_FAST)
  return cpp_fast_path(value);
#elif defined(LORE_CPP_SAFE)
  return cpp_safe_path(value);
#else
  return value;
#endif
}

} // namespace lore_fixture
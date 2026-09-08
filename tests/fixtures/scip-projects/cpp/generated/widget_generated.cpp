#include "lore_fixture/model.hpp"

namespace lore_fixture {

Packet generated_packet() {
  return Packet{doubled(5)};
}

} // namespace lore_fixture
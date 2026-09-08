#ifndef LORE_FIXTURE_COMPAT_H
#define LORE_FIXTURE_COMPAT_H

namespace lore_fixture {

class LegacyFlag {
public:
  explicit LegacyFlag(bool enabled) : enabled_(enabled) {}
  bool enabled() const { return enabled_; }

private:
  bool enabled_;
};

} // namespace lore_fixture

#endif
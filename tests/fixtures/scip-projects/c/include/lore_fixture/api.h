#ifndef LORE_FIXTURE_API_H
#define LORE_FIXTURE_API_H

#define LORE_FIXTURE_SCALE(value) ((value) * 2)
#define LORE_FIXTURE_MAGIC 17

typedef unsigned long lore_id_t;

typedef struct LoreRecord {
  lore_id_t id;
  const char *label;
} LoreRecord;

struct LoreContext;

int lore_add(int left, int right);
LoreRecord lore_make_record(lore_id_t id, const char *label);
int lore_context_value(const struct LoreContext *context);
int lore_unicode_value(int value);
int lore_declared_only(int value);
int lore_fast_path(int value);
int lore_safe_path(int value);
int lore_configured_value(int value);

#endif
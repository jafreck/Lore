/**
 * @module indexer/config-parser
 *
 * Parses configuration artifacts into a normalized shape for persistence.
 */

import { basename, extname } from 'node:path';

export type ConfigValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface ConfigEntry {
  key: string;
  value: string | null;
  defaultValue: string | null;
  inferredType: ConfigValueType;
  required: boolean;
  description?: string;
}

type ConfigObject = Record<string, unknown>;

interface MetadataObject {
  value?: unknown;
  default?: unknown;
  type?: unknown;
  required?: unknown;
  description?: unknown;
}

export function parseConfigFile(filePath: string, content: string): ConfigEntry[] {
  const lowerBase = basename(filePath).toLowerCase();
  const lowerExt = extname(filePath).toLowerCase();

  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) {
    return parseEnvConfig(content);
  }
  if (lowerExt === '.json') {
    return flattenStructured(parseJsonConfig(content));
  }
  if (lowerExt === '.yaml' || lowerExt === '.yml') {
    return flattenStructured(parseYamlConfig(content));
  }
  if (lowerExt === '.toml') {
    return flattenStructured(parseTomlConfig(content));
  }

  throw new Error(`Unsupported config format: ${filePath}`);
}

function parseEnvConfig(content: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  let pendingDescription: string | undefined;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      pendingDescription = undefined;
      continue;
    }
    if (line.startsWith('#')) {
      const comment = line.slice(1).trim();
      pendingDescription = pendingDescription ? `${pendingDescription} ${comment}` : comment;
      continue;
    }

    const envLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = envLine.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/u);
    if (!match) {
      throw new Error(`Invalid .env entry: ${rawLine}`);
    }

    const key = match[1]!;
    const rawValue = (match[2] ?? '').trim();
    const value = normalizeQuotedValue(rawValue);
    const inferredType = inferType(value);
    const entry: ConfigEntry = {
      key,
      value,
      defaultValue: value,
      inferredType,
      required: value === null,
    };
    if (pendingDescription) {
      entry.description = pendingDescription;
    }
    entries.push(entry);
    pendingDescription = undefined;
  }

  return entries;
}

function parseJsonConfig(content: string): ConfigObject {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error('JSON config must be an object');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parse error';
    throw new Error(`Invalid JSON config: ${message}`);
  }
}

function parseYamlConfig(content: string): ConfigObject {
  const root: ConfigObject = {};
  const stack: Array<{ indent: number; object: ConfigObject }> = [{ indent: -1, object: root }];

  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (rawLine.includes('\t')) throw new Error(`Invalid YAML config at line ${index + 1}: tabs are not supported`);

    const indent = rawLine.length - rawLine.trimStart().length;
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) {
      stack.pop();
    }

    const separator = trimmed.indexOf(':');
    if (separator < 1) throw new Error(`Invalid YAML config at line ${index + 1}`);

    const key = trimmed.slice(0, separator).trim();
    const valuePart = trimmed.slice(separator + 1).trim();
    const parent = stack.at(-1)!.object;

    if (!valuePart) {
      const child: ConfigObject = {};
      parent[key] = child;
      stack.push({ indent, object: child });
      continue;
    }

    parent[key] = parseScalar(valuePart);
  }

  return root;
}

function parseTomlConfig(content: string): ConfigObject {
  const root: ConfigObject = {};
  let current: ConfigObject = root;

  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/u);
    if (sectionMatch) {
      current = ensureObjectPath(root, sectionMatch[1]!.split('.').map((segment) => segment.trim()));
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/u);
    if (!assignment) throw new Error(`Invalid TOML config at line ${index + 1}`);

    setTomlValue(current, assignment[1]!.split('.').map((segment) => segment.trim()), parseScalar(assignment[2]!.trim()));
  }

  return root;
}

function setTomlValue(target: ConfigObject, path: string[], value: unknown): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const existing = current[key];
    if (!isPlainObject(existing)) {
      const next: ConfigObject = {};
      current[key] = next;
      current = next;
      continue;
    }
    current = existing;
  }
  const lastKey = path[path.length - 1];
  if (!lastKey) throw new Error('Invalid TOML key path');
  current[lastKey] = value;
}

function ensureObjectPath(root: ConfigObject, path: string[]): ConfigObject {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!isPlainObject(existing)) {
      const next: ConfigObject = {};
      current[key] = next;
      current = next;
      continue;
    }
    current = existing;
  }
  return current;
}

function flattenStructured(obj: ConfigObject, prefix = ''): ConfigEntry[] {
  const entries: ConfigEntry[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (isMetadataObject(value)) {
      entries.push(metadataToEntry(fullKey, value));
      continue;
    }
    if (isPlainObject(value)) {
      entries.push(...flattenStructured(value, fullKey));
      continue;
    }

    const normalized = normalizeValue(value);
    entries.push({
      key: fullKey,
      value: normalized,
      defaultValue: normalized,
      inferredType: inferType(value),
      required: value === null,
    });
  }

  return entries;
}

function metadataToEntry(key: string, metadata: MetadataObject): ConfigEntry {
  const hasValue = Object.prototype.hasOwnProperty.call(metadata, 'value');
  const hasDefault = Object.prototype.hasOwnProperty.call(metadata, 'default');
  const normalizedValue = hasValue ? normalizeValue(metadata.value ?? null) : normalizeValue(metadata.default ?? null);
  const normalizedDefault = hasDefault ? normalizeValue(metadata.default ?? null) : null;
  const inferredType = toKnownType(metadata.type) ?? inferType(hasValue ? metadata.value : metadata.default);
  const required = typeof metadata.required === 'boolean' ? metadata.required : !hasValue && !hasDefault;

  const entry: ConfigEntry = {
    key,
    value: normalizedValue,
    defaultValue: normalizedDefault,
    inferredType,
    required,
  };

  if (typeof metadata.description === 'string') {
    entry.description = metadata.description;
  }

  return entry;
}

function toKnownType(value: unknown): ConfigValueType | null {
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'null' || value === 'array' || value === 'object') {
    return value;
  }
  return null;
}

function parseScalar(raw: string): unknown {
  const normalized = normalizeQuotedValue(raw);
  if (normalized === null) return null;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === 'null') return null;
  if (/^-?\d+(\.\d+)?$/u.test(normalized)) return Number(normalized);
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    const body = normalized.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((part) => parseScalar(part.trim()));
  }
  return normalized;
}

function normalizeQuotedValue(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function inferType(value: unknown): ConfigValueType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMetadataObject(value: unknown): value is MetadataObject {
  if (!isPlainObject(value)) return false;
  const metaKeys = ['value', 'default', 'type', 'required', 'description'];
  const matchCount = metaKeys.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).length;
  // Require at least two metadata-like keys to avoid false-positives on
  // normal config objects that happen to contain common property names like
  // "type" or "description".
  return matchCount >= 2;
}

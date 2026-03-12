import { helper } from './utils';

export async function loadPlugin() {
  const config = await import('./config');
  return config.default;
}

// Dynamic import with a variable — should NOT be extracted as an import edge
export async function loadDynamic(name: string) {
  const mod = await import(name);
  return mod;
}

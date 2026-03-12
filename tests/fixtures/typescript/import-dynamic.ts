import { helper } from './utils';

export async function loadPlugin() {
  const config = await import('./config');
  return config.default;
}

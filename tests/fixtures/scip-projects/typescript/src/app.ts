/**
 * Main application entry point.
 */
import { add, defaultConfig, StringHelper, type AppConfig } from './util.js';

/** Initialize and run the application. */
export function main(): void {
  const config: AppConfig = defaultConfig();
  const result = add(config.port, 1);
  const helper = new StringHelper('App');
  console.log(helper.format(`running on port ${result}`));
}

/** Process a list of items. */
export function processItems(items: string[]): number {
  let total = 0;
  for (const item of items) {
    total += add(item.length, 1);
  }
  return total;
}

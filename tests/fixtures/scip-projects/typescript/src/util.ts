/**
 * Utility functions shared across the project.
 */

/** Configuration options for the application. */
export interface AppConfig {
  name: string;
  port: number;
  debug: boolean;
}

/** Add two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Create a default configuration. */
export function defaultConfig(): AppConfig {
  return { name: 'app', port: 3000, debug: false };
}

/** A simple helper class for string operations. */
export class StringHelper {
  constructor(private readonly prefix: string) {}

  /** Format a value with the configured prefix. */
  format(value: string): string {
    return `${this.prefix}: ${value}`;
  }
}

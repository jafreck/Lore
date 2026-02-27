import { readFileSync } from 'fs';
import path from 'path';

export function greet(name) {
  return `Hello, ${name}!`;
}

export function add(a, b) {
  return a + b;
}

export class Animal {
  constructor(name) {
    this.name = name;
  }

  speak() {
    return `${this.name} makes a noise.`;
  }
}

export const multiply = (a, b) => a * b;

export const formatPath = (p) => path.normalize(p);

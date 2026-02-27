import { readFileSync } from 'fs';
import path from 'path';

export interface Shape {
  area(): number;
  perimeter(): number;
}

export type Point = {
  x: number;
  y: number;
};

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class Circle implements Shape {
  constructor(private radius: number) {}

  area(): number {
    return Math.PI * this.radius ** 2;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

export const multiply = (a: number, b: number): number => a * b;

export const formatPath = (p: string): string => path.normalize(p);

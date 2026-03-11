import { readFileSync } from 'fs';
import path from 'path';
import * as os from 'os';

export interface Shape {
  area(): number;
  perimeter(): number;
}

export interface Describable extends Shape {
  name: string;
  describe(detail: boolean): string;
}

export type Point = {
  x: number;
  y: number;
};

export enum Color { Red, Green, Blue }

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class BaseShape {}

export class Circle extends BaseShape implements Shape {
  private label: string = '';

  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius ** 2;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

export const multiply = (a: number, b: number): number => a * b;

export const handler = function(req: Request): Response { return new Response(); };

export const gen = function* () { yield 1; };

export const formatPath = (p: string): string => path.normalize(p);

export function convert(value: unknown): string {
  const s = value as string;
  const n = <number>value;
  return s;
}

const items: Point[] = [];
const config: Shape | null = null;
const combo: Shape & Describable = {} as Shape & Describable;

export function* sequence(): Generator<number> {
  yield 1;
  yield 2;
}

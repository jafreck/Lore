import { readFileSync } from 'fs';
import path from 'path';
import * as os from 'os';

const utils = require('utils');

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

const app = { get() {}, post() {} };
const koaRouter = { get() {} };
const hono = { get() {} };

app.get('/health', greet);
app.post('/add', add);
app.put('/update', greet);
app.delete('/remove', greet);
app.patch('/modify', greet);
koaRouter.get('/koa', formatPath, multiply);
hono.get('/hono', multiply);

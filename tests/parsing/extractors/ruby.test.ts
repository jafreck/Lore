import { describe, it, expect } from 'vitest';
import { RubyExtractor } from '../../../src/parsing/extractors/ruby.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new RubyExtractor();

function extract(source: string) {
  const tree = pool.parse('ruby', source)!;
  return extractor.extract(tree, source, 'test.rb');
}

describe('RubyExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts method definition', () => {
      const result = extract(`def greet(name)\n  puts "Hello #{name}"\nend`);
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class declaration', () => {
      const source = `class Animal
  def speak
    "..."
  end
end`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Animal' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('extracts class with superclass', () => {
      const source = `class Dog < Animal
  def speak
    "Woof"
  end
end`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Dog' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('extracts module declaration', () => {
      const source = `module Serializable
  def serialize
    to_s
  end
end`;
      const result = extract(source);
      const mod = result.symbols.find(s => s.name === 'Serializable' && s.kind === 'module');
      expect(mod).toBeDefined();
    });

    it('extracts singleton method (self.method)', () => {
      const source = `class Foo
  def self.create
    new
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name.includes('create') && s.kind === 'function');
      expect(sym).toBeDefined();
      expect(sym!.name).toContain('self');
    });

    it('extracts nested class and module', () => {
      const source = `module MyApp
  class Server
    def start
    end
  end
end`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'MyApp' && s.kind === 'module')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'Server' && s.kind === 'class')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'start' && s.kind === 'function')).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts require statement', () => {
      const result = extract(`require 'json'`);
      const imp = result.imports.find(i => i.source === 'json');
      expect(imp).toBeDefined();
    });

    it('extracts require_relative statement', () => {
      const result = extract(`require_relative 'helpers/utils'`);
      const imp = result.imports.find(i => i.source === 'helpers/utils');
      expect(imp).toBeDefined();
    });

    it('extracts multiple requires', () => {
      const source = `require 'net/http'
require 'json'
require 'uri'`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('call ref extraction', () => {
    it('extracts method calls', () => {
      const source = `class Foo
  def bar
    puts "hello"
  end
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'puts');
      expect(ref).toBeDefined();
    });

    it('extracts method calls with receiver', () => {
      const source = `class Foo
  def bar
    list.each { |x| puts x }
  end
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('each'));
      expect(ref).toBeDefined();
    });

    it('tracks caller symbol for method calls', () => {
      const source = `def process
  helper()
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'helper');
      if (ref) {
        expect(ref.callerSymbol).toBe('process');
      }
    });
  });

  describe('attr_accessor patterns', () => {
    it('extracts attr_accessor calls', () => {
      const source = `class User
  attr_accessor :name, :email
  def initialize(name, email)
    @name = name
    @email = email
  end
end`;
      const result = extract(source);
      // attr_accessor is a method call
      const ref = result.callRefs.find(r => r.calleeRaw === 'attr_accessor');
      expect(ref).toBeDefined();
    });

    it('extracts attr_reader calls', () => {
      const source = `class Config
  attr_reader :host, :port
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'attr_reader');
      expect(ref).toBeDefined();
    });
  });

  describe('module mixin calls', () => {
    it('extracts include calls', () => {
      const source = `class MyController
  include Authentication
  include Authorization
end`;
      const result = extract(source);
      const refs = result.callRefs.filter(r => r.calleeRaw === 'include');
      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts extend calls', () => {
      const source = `class MyModel
  extend ClassMethods
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'extend');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
    });

    it('handles class with no methods', () => {
      const result = extract('class Empty\nend');
      const cls = result.symbols.find(s => s.name === 'Empty');
      expect(cls).toBeDefined();
    });

    it('handles standalone method outside class', () => {
      const result = extract('def standalone\n  42\nend');
      const sym = result.symbols.find(s => s.name === 'standalone');
      expect(sym).toBeDefined();
    });
  });
});

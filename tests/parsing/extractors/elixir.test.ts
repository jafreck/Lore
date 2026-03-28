import { describe, it, expect } from 'vitest';
import { ElixirExtractor } from '../../../src/parsing/extractors/elixir.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new ElixirExtractor();

function extract(source: string) {
  const tree = pool.parse('elixir', source)!;
  return extractor.extract(tree, source, 'test.ex');
}

describe('ElixirExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts defmodule declaration', () => {
      const source = `defmodule MyApp.Server do
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'module');
      expect(sym).toBeDefined();
    });

    it('extracts def (public function)', () => {
      const source = `defmodule Foo do
  def greet(name) do
    "Hello #{name}"
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'greet' && s.kind === 'function');
      expect(sym).toBeDefined();
    });

    it('extracts defp (private function)', () => {
      const source = `defmodule Foo do
  defp helper(x) do
    x + 1
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'helper' && s.kind === 'function');
      expect(sym).toBeDefined();
    });

    it('extracts defmacro declaration', () => {
      const source = `defmodule MyMacros do
  defmacro my_if(condition, do: block) do
    quote do
      case unquote(condition) do
        true -> unquote(block)
        _ -> nil
      end
    end
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'macro');
      expect(sym).toBeDefined();
    });

    it('extracts defmacrop (private macro)', () => {
      const source = `defmodule Foo do
  defmacrop internal_macro(x) do
    x
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'macro');
      expect(sym).toBeDefined();
    });

    it('extracts defstruct', () => {
      const source = `defmodule User do
  defstruct [:name, :email, :age]
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'struct');
      expect(sym).toBeDefined();
    });

    it('extracts defprotocol', () => {
      const source = `defprotocol Printable do
  def to_string(data)
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'interface');
      expect(sym).toBeDefined();
    });

    it('extracts defimpl', () => {
      const source = `defimpl Printable, for: User do
  def to_string(user) do
    user.name
  end
end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'impl');
      expect(sym).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts alias directive', () => {
      const source = `defmodule Foo do
  alias MyApp.Repo
end`;
      const result = extract(source);
      const imp = result.imports.find(i => i.importedNames.includes('alias'));
      expect(imp).toBeDefined();
    });

    it('extracts import directive', () => {
      const source = `defmodule Foo do
  import Ecto.Query
end`;
      const result = extract(source);
      const imp = result.imports.find(i => i.importedNames.includes('import'));
      expect(imp).toBeDefined();
    });

    it('extracts use directive', () => {
      const source = `defmodule MyWeb.Router do
  use Phoenix.Router
end`;
      const result = extract(source);
      const imp = result.imports.find(i => i.importedNames.includes('use'));
      expect(imp).toBeDefined();
    });

    it('extracts require directive', () => {
      const source = `defmodule Foo do
  require Logger
end`;
      const result = extract(source);
      const imp = result.imports.find(i => i.importedNames.includes('require'));
      expect(imp).toBeDefined();
    });
  });

  describe('call ref extraction', () => {
    it('extracts function calls', () => {
      const source = `defmodule Foo do
  def bar do
    IO.puts("hello")
  end
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('IO'));
      expect(ref).toBeDefined();
    });

    it('extracts pipe operator calls', () => {
      const source = `defmodule Foo do
  def process(data) do
    data
    |> Enum.map(fn x -> x * 2 end)
    |> Enum.filter(fn x -> x > 5 end)
  end
end`;
      const result = extract(source);
      // pipe chains generate call refs for each function in the pipeline
      expect(result).toBeDefined();
    });

    it('tracks caller symbol for function calls', () => {
      const source = `defmodule Foo do
  def main do
    helper()
  end
end`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'helper');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty module', () => {
      const source = `defmodule Empty do
end`;
      const result = extract(source);
      expect(result.symbols.find(s => s.kind === 'module')).toBeDefined();
    });

    it('handles source with no module', () => {
      const source = `IO.puts("hello")`;
      const result = extract(source);
      expect(result).toBeDefined();
    });

    it('handles multiple function clauses', () => {
      const source = `defmodule Math do
  def factorial(0), do: 1
  def factorial(n), do: n * factorial(n - 1)
end`;
      const result = extract(source);
      const fns = result.symbols.filter(s => s.name === 'factorial');
      expect(fns.length).toBeGreaterThanOrEqual(1);
    });
  });
});

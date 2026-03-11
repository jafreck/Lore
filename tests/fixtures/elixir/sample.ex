defmodule Sample do
  alias Sample.Utils
  import Enum, only: [map: 2]

  def greet(name) do
    "Hello, #{name}!"
  end

  defp format(value) do
    to_string(value)
  end

  def add(a, b), do: a + b
end

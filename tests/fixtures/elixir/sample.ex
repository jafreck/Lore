defmodule Sample do
  alias Sample.Utils
  import Enum, only: [map: 2]
  use GenServer
  require Logger

  defstruct [:name, :value]

  def greet(name) do
    "Hello, #{name}!"
  end

  defp format(value) do
    to_string(value)
  end

  def add(a, b), do: a + b
end

defprotocol Stringify do
  def to_str(value)
end

defimpl Stringify, for: Integer do
  def to_str(value), do: Integer.to_string(value)
end

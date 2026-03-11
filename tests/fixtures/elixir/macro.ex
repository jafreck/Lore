defmodule M do
  defmacro debug(expr) do
    quote do: IO.inspect(unquote(expr))
  end
end

defmodule M do
  defguard is_positive(x) when x > 0
  defdelegate to_s(x), to: Integer
end

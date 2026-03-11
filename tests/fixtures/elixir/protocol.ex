defprotocol Stringify do
  def to_str(value)
end

defimpl Stringify, for: Integer do
  def to_str(v), do: Integer.to_string(v)
end

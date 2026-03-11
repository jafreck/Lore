defmodule M do
  alias Sample.Utils
  import Enum, only: [map: 2]
  use GenServer
  require Logger
end

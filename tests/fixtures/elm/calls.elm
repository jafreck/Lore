module Calls exposing (main, helper)

import Html exposing (text)

helper : String -> String
helper name =
    String.toUpper name

main : String
main =
    helper "world"

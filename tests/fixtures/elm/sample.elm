module Sample exposing (greet, add)

import Html exposing (Html, text)
import String

type alias Point =
    { x : Float
    , y : Float
    }

type Shape
    = Circle Float
    | Rectangle Float Float

greet : String -> String
greet name =
    "Hello, " ++ name ++ "!"

add : Int -> Int -> Int
add a b =
    a + b

module Sample exposing (greet, add, version)

import Html exposing (Html, text)
import String

type alias Point =
    { x : Float
    , y : Float
    }

type Shape
    = Circle Float
    | Rectangle Float Float

port sendMessage : String -> Cmd msg

greet : String -> String
greet name =
    "Hello, " ++ name ++ "!"

add : Int -> Int -> Int
add a b =
    a + b

version =
    "1.0.0"

view model =
    Html.div []
        [ Html.text (String.fromInt model)
        , Html.button [] [ Html.text "+" ]
        ]

type Msg
    = Increment
    | Decrement
    | Reset

update : Msg -> Int -> Int
update msg model =
    case msg of
        Increment -> model + 1
        Decrement -> model - 1
        Reset -> 0

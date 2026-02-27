open Printf
open List

let pi = 3.14159265358979

let greet name =
  printf "Hello, %s!\n" name

let add a b = a + b

let square x = x * x

type shape =
  | Circle of float
  | Rectangle of float * float

let area s =
  match s with
  | Circle r -> pi *. r *. r
  | Rectangle (w, h) -> w *. h

module MathUtils = struct
  let clamp value min_val max_val =
    if value < min_val then min_val
    else if value > max_val then max_val
    else value
end

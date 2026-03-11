module Sample (greet, add) where

import Data.List (sort, nub)
import qualified Data.Map as Map

data Shape = Circle Double | Rectangle Double Double

type Name = String

greet :: Name -> String
greet name = "Hello, " ++ name ++ "!"

add :: Int -> Int -> Int
add a b = a + b

module Sample (greet, add, Name, Shape) where

import Data.List (sort, nub)
import qualified Data.Map as Map

data Shape = Circle Double | Rectangle Double Double

type Name = String

greet :: Name -> String
greet name = "Hello, " ++ name ++ "!"

add :: Int -> Int -> Int
add a b = a + b

main :: IO ()
main = do
  let msg = greet "World"
  let total = add 1 2
  putStrLn msg

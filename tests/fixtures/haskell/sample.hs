module Sample (greet, add, Name, Shape) where

import Data.List (sort, nub)
import qualified Data.Map as Map

data Shape = Circle Double | Rectangle Double Double

newtype Wrapper a = Wrapper a

type Name = String

class Describable a where
  describe :: a -> String

instance Describable Shape where
  describe (Circle r) = "Circle " ++ show r
  describe (Rectangle w h) = "Rect " ++ show w ++ "x" ++ show h

greet :: Name -> String
greet name = "Hello, " ++ name ++ "!"

add :: Int -> Int -> Int
add a b = a + b

main :: IO ()
main = do
  let msg = greet "World"
  let total = add 1 2
  putStrLn msg

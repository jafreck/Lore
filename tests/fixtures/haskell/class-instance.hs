class Describable a where
  describe :: a -> String

instance Describable Int where
  describe x = show x

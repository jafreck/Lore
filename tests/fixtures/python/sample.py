import os
import sys
from pathlib import Path
from typing import List, Optional
from os.path import join as pathjoin
from os.path import *

def greet(name: str) -> str:
    return f"Hello, {name}!"

def add(a: int, b: int) -> int:
    return a + b

async def fetch_data(url: str) -> bytes:
    return b""

class Animal:
    def __init__(self, name: str) -> None:
        self.name = name

    def speak(self) -> str:
        return f"{self.name} makes a noise."

class Dog(Animal):
    def speak(self) -> str:
        return f"{self.name} barks."

def main():
    greeting = greet("World")
    total = add(1, 2)
    dog = Dog("Rex")
    dog.speak()
    print(greeting)

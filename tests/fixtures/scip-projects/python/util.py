"""Utility functions shared across the project."""


class AppConfig:
    """Configuration for the application."""

    def __init__(self, name: str = "app", port: int = 3000, debug: bool = False):
        self.name = name
        self.port = port
        self.debug = debug


def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


def default_config() -> AppConfig:
    """Create a default configuration."""
    return AppConfig()


class StringHelper:
    """A helper for formatting strings with a prefix."""

    def __init__(self, prefix: str):
        self.prefix = prefix

    def format(self, value: str) -> str:
        """Format a value with the configured prefix."""
        return f"{self.prefix}: {value}"

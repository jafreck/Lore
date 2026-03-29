"""Main application entry point."""
from util import add, default_config, StringHelper, AppConfig


def main() -> None:
    """Initialize and run the application."""
    config: AppConfig = default_config()
    result = add(config.port, 1)
    helper = StringHelper("App")
    print(helper.format(f"running on port {result}"))


def process_items(items: list[str]) -> int:
    """Process a list of items."""
    total = 0
    for item in items:
        total = add(total, len(item))
    return total

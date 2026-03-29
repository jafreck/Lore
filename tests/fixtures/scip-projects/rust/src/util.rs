/// Application configuration.
pub struct Config {
    pub name: String,
    pub port: u16,
    pub debug: bool,
}

/// Returns the default configuration.
pub fn default_config() -> Config {
    Config {
        name: String::from("app"),
        port: 3000,
        debug: false,
    }
}

/// Adds two numbers.
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// A helper for formatting strings with a prefix.
pub struct StringHelper {
    pub prefix: String,
}

impl StringHelper {
    /// Creates a new StringHelper.
    pub fn new(prefix: &str) -> Self {
        StringHelper {
            prefix: prefix.to_string(),
        }
    }

    /// Formats a value with the prefix.
    pub fn format(&self, value: &str) -> String {
        format!("{}: {}", self.prefix, value)
    }
}

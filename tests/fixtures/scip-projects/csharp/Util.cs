namespace ScipFixture;

/// <summary>Application configuration.</summary>
public class AppConfig
{
    public string Name { get; set; } = "app";
    public int Port { get; set; } = 3000;
    public bool Debug { get; set; } = false;
}

/// <summary>Utility functions.</summary>
public static class Util
{
    /// <summary>Add two numbers.</summary>
    public static int Add(int a, int b) => a + b;

    /// <summary>Create a default configuration.</summary>
    public static AppConfig DefaultConfig() => new AppConfig();
}

/// <summary>A helper for formatting strings with a prefix.</summary>
public class StringHelper
{
    private readonly string _prefix;

    public StringHelper(string prefix) => _prefix = prefix;

    /// <summary>Format a value with the configured prefix.</summary>
    public string Format(string value) => $"{_prefix}: {value}";
}

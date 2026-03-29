using ScipFixture;

/// <summary>Main application entry point.</summary>
public class App
{
    public static void Main(string[] args)
    {
        var config = Util.DefaultConfig();
        var result = Util.Add(config.Port, 1);
        var helper = new StringHelper("App");
        Console.WriteLine(helper.Format($"running on port {result}"));
    }

    public static int ProcessItems(string[] items)
    {
        var total = 0;
        foreach (var item in items)
        {
            total = Util.Add(total, item.Length);
        }
        return total;
    }
}

using System;
using System.Collections.Generic;
using Project = System.Console;

namespace Sample
{
    public struct Point
    {
        public int X;
        public int Y;
    }

    public class Greeter
    {
        private readonly string _name;

        public Greeter(string name)
        {
            _name = name;
        }

        public string Greet()
        {
            return $"Hello, {_name}!";
        }
    }

    public interface ICalculator
    {
        int Add(int a, int b);
    }

    public interface IAdvancedCalculator : ICalculator
    {
        double Sqrt(double x);
    }

    public class MathCalc : IAdvancedCalculator
    {
        private double _lastResult;
        public int Add(int a, int b) { return a + b; }
        public double Sqrt(double x) { return Math.Sqrt(x); }
    }

    public enum Color
    {
        Red,
        Green,
        Blue
    }

    public static class Program
    {
        public static void Main()
        {
            var greeter = new Greeter("World");
            Console.WriteLine(greeter.Greet());
            var point = new Point();
            var x = (int)3.14;
            var obj = greeter as object;
            List<int> items = new List<int>();
        }
    }
}

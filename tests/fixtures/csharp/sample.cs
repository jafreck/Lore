using System;
using System.Collections.Generic;

namespace Sample
{
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
}

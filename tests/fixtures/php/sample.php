<?php

use App\Models\User;
use App\Services\{Mailer, Logger};

function greet(string $name): string {
    return "Hello, $name!";
}

function add(int $a, int $b): int {
    return $a + $b;
}

interface Shape {
    public function area(): float;
    public function perimeter(): float;
}

class Circle implements Shape {
    public function __construct(private float $radius) {}

    public function area(): float {
        return M_PI * $this->radius ** 2;
    }

    public function perimeter(): float {
        return 2 * M_PI * $this->radius;
    }
}

trait Greetable {
    public function greetUser(): string {
        return "Hello from trait!";
    }
}

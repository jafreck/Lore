<?php

namespace App\Controllers;

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

interface Movable {
    public function move(float $x, float $y): void;
}

class Animal {
    public string $name;
    public ?int $age = null;
}

class Circle extends Animal implements Shape {
    public function __construct(private float $radius) {
        parent::__construct();
    }

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

function main(): void {
    $msg = greet("World");
    $sum = add(1, 2);
    $c = new Circle(5.0);
    echo $c->area();
    $c->perimeter();
    $items = new \ArrayObject();
    $name = (string) $sum;
    $x = $c instanceof Shape;
    $val = Circle::class;
    echo Animal::class;
}

enum Color {
    case Red;
    case Green;
    case Blue;
}

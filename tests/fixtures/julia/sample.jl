module Sample

using LinearAlgebra
import Base: show

struct Point
    x::Float64
    y::Float64
end

macro sayhello(name)
    return :(println("Hello, ", $(esc(name))))
end

f(x) = x + 1
square(x) = x * x

function greet(name::String)::String
    return "Hello, $name!"
end

function add(a::Int, b::Int)::Int
    a + b
end

function main()
    msg = greet("World")
    total = add(1, 2)
    println(msg)
end

abstract type AbstractShape end

mutable struct Rectangle <: AbstractShape
    width::Float64
    height::Float64
end

end # module

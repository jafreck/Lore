module Sample

using LinearAlgebra
import Base: show

struct Point
    x::Float64
    y::Float64
end

function greet(name::String)::String
    return "Hello, $name!"
end

function add(a::Int, b::Int)::Int
    a + b
end

end # module

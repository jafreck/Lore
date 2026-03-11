local json = require("json")
local utils = require("utils")

function greet(name)
    return "Hello, " .. name .. "!"
end

function add(a, b)
    return a + b
end

local function square(x)
    return x * x
end

local function clamp(value, min, max)
    if value < min then return min end
    if value > max then return max end
    return value
end

local function main()
    local msg = greet("World")
    local sum = add(1, 2)
    local sq = square(sum)
    print(msg)
end

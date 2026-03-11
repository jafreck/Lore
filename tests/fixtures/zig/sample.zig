const std = @import("std");
const math = @import("std").math;

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}!\n", .{name});
}

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

pub fn square(x: i32) i32 {
    return x * x;
}

pub const Point = struct {
    x: f64,
    y: f64,

    pub fn distance(self: Point, other: Point) f64 {
        const dx = self.x - other.x;
        const dy = self.y - other.y;
        return math.sqrt(dx * dx + dy * dy);
    }
};

pub const Color = enum {
    Red,
    Green,
    Blue,
};

test "add returns correct sum" {
    try std.testing.expectEqual(@as(i32, 5), add(2, 3));
}

#import <Foundation/Foundation.h>
#import "Shape.h"
@import UIKit;

@protocol Drawable <NSObject>
- (void)draw;
- (CGRect)bounds;
@end

@interface Circle : NSObject <Drawable> {
    NSString *_name;
    NSInteger _count;
}

@property (nonatomic) double radius;

- (instancetype)initWithRadius:(double)radius;
- (double)area;
- (double)perimeter;
- (void)processData:(NSData *)data withCompletion:(void (^)(BOOL))handler;

@end

@implementation Circle

- (instancetype)initWithRadius:(double)radius {
    self = [super init];
    if (self) {
        _radius = radius;
    }
    return self;
}

- (double)area {
    return M_PI * _radius * _radius;
}

- (double)perimeter {
    return 2 * M_PI * _radius;
}

- (void)draw {
    NSLog(@"Circle r=%f", _radius);
}

- (CGRect)bounds {
    return CGRectZero;
}

- (void)processData:(NSData *)data withCompletion:(void (^)(BOOL))handler {
    handler(YES);
}

@end

@interface NSString (Utilities)
- (BOOL)isBlank;
@end

@protocol Serializable <Drawable>
- (NSData *)serialize;
@end

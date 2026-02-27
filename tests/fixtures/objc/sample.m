#import <Foundation/Foundation.h>
#import "Shape.h"

@interface Circle : NSObject

@property (nonatomic) double radius;

- (instancetype)initWithRadius:(double)radius;
- (double)area;
- (double)perimeter;

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

@end

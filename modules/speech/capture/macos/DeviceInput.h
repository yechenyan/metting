#import <AVFoundation/AVFoundation.h>

typedef void (^InputBufferHandler)(AVAudioPCMBuffer *, double);
typedef void (^InputErrorHandler)(NSString *);

@interface DeviceInput : NSObject
- (NSString *)prepare:(NSString *)uid channel:(NSUInteger)channel
              receive:(InputBufferHandler)receive failure:(InputErrorHandler)failure;
- (BOOL)start;
@end

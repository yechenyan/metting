#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <CoreMedia/CoreMedia.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <unistd.h>
#import "AudioInputs.h"
#import "DeviceInput.h"

static void report(NSString *event, NSString *code, NSString *detail) {
  NSMutableDictionary *message = [@{@"event" : event} mutableCopy];
  if (code) message[@"code"] = code;
  if (detail) message[@"detail"] = detail;
  NSData *data = [NSJSONSerialization
      dataWithJSONObject:message
                 options:0
                   error:nil];
  fwrite(data.bytes, 1, data.length, stderr);
  fputc('\n', stderr);
  fflush(stderr);
}
static void fail(NSString *code, NSString *detail) {
  report(@"error", code, detail);
  exit(2);
}
static void failStream(NSError *error) {
  if ([error.domain isEqualToString:SCStreamErrorDomain] &&
      error.code == SCStreamErrorUserDeclined)
    fail(@"systemAudioPermission", nil);
  fail(@"captureError", error.localizedDescription);
}

@interface Capture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) DeviceInput *input;
@property(nonatomic, strong) AVAudioFormat *target;
@property(nonatomic, strong) AVAudioConverter *converter;
@property(nonatomic) NSUInteger channel;
@property(nonatomic) double origin;
@end
@implementation Capture
- (instancetype)init {
  if ((self = [super init])) {
    _target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                               sampleRate:16000
                                                 channels:1
                                              interleaved:NO];
    _channel = 1;
    _origin = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()));
  }
  return self;
}
- (void)writeBuffer:(AVAudioPCMBuffer *)buffer
              track:(uint8_t)track
               time:(double)time {
  AVAudioConverter *converter = self.converter;
  if (![converter.inputFormat isEqual:buffer.format]) {
    converter = monoConverter(buffer.format, self.target, self.channel);
    if (!converter)
      fail(@"inputFormatUnavailable", nil);
    self.converter = converter;
  }
  AVAudioFrameCount capacity =
      ceil(buffer.frameLength * 16000.0 / buffer.format.sampleRate) + 16;
  AVAudioPCMBuffer *out =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.target
                                    frameCapacity:capacity];
  __block BOOL given = NO;
  NSError *error = nil;
  [converter convertToBuffer:out
                       error:&error
          withInputFromBlock:^AVAudioBuffer *(
              AVAudioPacketCount count, AVAudioConverterInputStatus *status) {
            if (given) {
              *status = AVAudioConverterInputStatus_NoDataNow;
              return nil;
            }
            given = YES;
            *status = AVAudioConverterInputStatus_HaveData;
            return buffer;
          }];
  if (error || !out.frameLength)
    return;
  uint64_t stamp = (uint64_t)fmax(0, (time - self.origin) * 1000);
  uint32_t length = out.frameLength * 2;
  fwrite(&track, 1, 1, stdout);
  fwrite(&stamp, 8, 1, stdout);
  fwrite(&length, 4, 1, stdout);
  fwrite(out.int16ChannelData[0], 1, length, stdout);
  fflush(stdout);
}
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
  @autoreleasepool {
    if (type != SCStreamOutputTypeAudio || !CMSampleBufferIsValid(sample))
      return;
    CMAudioFormatDescriptionRef description =
        CMSampleBufferGetFormatDescription(sample);
    if (!description)
      return;
    AVAudioFormat *format =
        [[AVAudioFormat alloc] initWithCMAudioFormatDescription:description];
    CMItemCount frames = CMSampleBufferGetNumSamples(sample);
    if (!format || frames <= 0)
      return;
    AVAudioPCMBuffer *buffer =
        [[AVAudioPCMBuffer alloc] initWithPCMFormat:format
                                      frameCapacity:(AVAudioFrameCount)frames];
    buffer.frameLength = (AVAudioFrameCount)frames;
    if (CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, 0, (int32_t)frames, buffer.mutableAudioBufferList) != noErr)
      return;
    [self writeBuffer:buffer
                track:0
                 time:CMTimeGetSeconds(
                          CMSampleBufferGetPresentationTimeStamp(sample))];
  }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  failStream(error);
}
- (void)startInput:(NSString *)uid channel:(NSUInteger)channel {
  self.channel = channel;
  self.input = [DeviceInput new];
  NSString *failure = [self.input prepare:uid channel:channel
      receive:^(AVAudioPCMBuffer *buffer, double time) {
        [self writeBuffer:buffer track:1 time:time];
      } failure:^(NSString *code) { fail(code, nil); }];
  if (failure) fail(failure, nil);
  if (![self.input start]) fail(@"inputDeviceUnavailable", nil);
  report(@"ready", nil, nil);
}
- (void)startSystem:(NSString *)application {
  [SCShareableContent
      getShareableContentExcludingDesktopWindows:NO
                             onScreenWindowsOnly:NO
                               completionHandler:^(SCShareableContent *content,
                                                   NSError *error) {
                                 if (error) failStream(error);
                                 if (!content.displays.count)
                                   fail(@"captureError", @"No display available for application audio.");
                                 SCDisplay *display =
                                     content.displays.firstObject;
                                 SCContentFilter *filter;
                                 if (application.length) {
                                   NSArray *matches = [content.applications
                                       filteredArrayUsingPredicate:
                                           [NSPredicate
                                               predicateWithFormat:
                                                   @"bundleIdentifier == %@",
                                                   application]];
                                   if (!matches.count)
                                     fail(@"captureError", @"The selected application is no "
                                          @"longer running.");
                                   filter = [[SCContentFilter alloc]
                                             initWithDisplay:display
                                       includingApplications:matches
                                            exceptingWindows:@[]];
                                 } else
                                   filter = [[SCContentFilter alloc]
                                        initWithDisplay:display
                                       excludingWindows:@[]];
                                 SCStreamConfiguration *config =
                                     [SCStreamConfiguration new];
                                 config.width = 2;
                                 config.height = 2;
                                 config.minimumFrameInterval = CMTimeMake(1, 1);
                                 config.capturesAudio = YES;
                                 config.sampleRate = 16000;
                                 config.channelCount = 1;
                                 config.excludesCurrentProcessAudio = YES;
                                 self.stream =
                                     [[SCStream alloc] initWithFilter:filter
                                                        configuration:config
                                                             delegate:self];
                                 dispatch_queue_t queue = dispatch_queue_create(
                                     "meeting.capture.audio",
                                     DISPATCH_QUEUE_SERIAL);
                                 NSError *err = nil;
                                 if (![self.stream
                                            addStreamOutput:self
                                                       type:
                                                           SCStreamOutputTypeAudio
                                         sampleHandlerQueue:queue
                                                      error:&err])
                                   failStream(err);
                                 [self.stream
                                     startCaptureWithCompletionHandler:^(
                                         NSError *err) {
                                       if (err)
                                         failStream(err);
                                       report(@"ready", nil, nil);
                                     }];
                               }];
}
@end
static Capture *capture;
static NSArray *runningApplications(void) {
  NSMutableArray *apps = [NSMutableArray new];
  NSMutableSet *ids = [NSMutableSet new];
  for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
    NSString *uid = app.bundleIdentifier;
    if (app.activationPolicy != NSApplicationActivationPolicyRegular ||
        !uid || !app.localizedName || [ids containsObject:uid]) continue;
    [ids addObject:uid];
    [apps addObject:@{@"id": uid, @"name": app.localizedName}];
  }
  return [apps sortedArrayUsingDescriptors:@[[NSSortDescriptor sortDescriptorWithKey:@"name"
      ascending:YES selector:@selector(localizedStandardCompare:)]]];
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    NSString *source = args.count > 1 ? args[1] : @"system";
    if ([source isEqualToString:@"inputs"] || [source isEqualToString:@"apps"]) {
      id result = runningApplications();
      if ([source isEqualToString:@"inputs"]) {
        NSMutableDictionary *inputs = [audioInputCatalog() mutableCopy];
        if (!inputs) fail(@"captureError", @"Unable to list Core Audio inputs.");
        inputs[@"applications"] = result;
        result = inputs;
      }
      NSData *data = [NSJSONSerialization dataWithJSONObject:result
                                                     options:0
                                                       error:nil];
      fwrite(data.bytes, 1, data.length, stdout);
      return 0;
    }
    NSString *selection = args.count > 2 ? args[2] : @"";
    capture = [Capture new];
    if ([source isEqualToString:@"system"])
      [capture startSystem:selection];
    else if ([source isEqualToString:@"mic"]) {
      NSInteger channel = args.count > 3 ? [args[3] integerValue] : 1;
      if (channel < 1) fail(@"inputChannelUnavailable", nil);
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                               completionHandler:^(BOOL granted) {
                                 if (!granted)
                                   fail(@"microphonePermission", nil);
                                 dispatch_async(dispatch_get_main_queue(), ^{
                                   [capture startInput:selection channel:(NSUInteger)channel];
                                 });
                               }];
    } else fail(@"captureError", @"Unknown capture source.");
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}

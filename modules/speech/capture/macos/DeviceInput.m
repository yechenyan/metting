#import "DeviceInput.h"
#import "AudioInputs.h"
#import <AudioToolbox/AudioToolbox.h>

@interface DeviceInput () {
  AudioQueueRef _queue;
  NSString *_uid;
  UInt32 _channels;
  InputErrorHandler _failure;
}
- (BOOL)matchesDevice;
@property(atomic) BOOL accepting;
@end

@implementation DeviceInput
- (BOOL)matchesDevice {
  CFStringRef uid = NULL;
  UInt32 size = sizeof(uid);
  if (AudioQueueGetProperty(_queue, kAudioQueueProperty_CurrentDevice, &uid, &size) != noErr)
    return NO;
  NSString *current = CFBridgingRelease(uid);
  UInt32 channels = 0;
  size = sizeof(channels);
  return [_uid isEqualToString:current] &&
      AudioQueueGetProperty(_queue, kAudioQueueDeviceProperty_NumberChannels, &channels, &size) == noErr &&
      channels == _channels;
}

static void queueChanged(void *context, AudioQueueRef queue, AudioQueuePropertyID property) {
  DeviceInput *input = (__bridge DeviceInput *)context;
  if (!input.accepting) return;
  if (property == kAudioQueueProperty_IsRunning) {
    UInt32 running = 0, size = sizeof(running);
    if (AudioQueueGetProperty(queue, property, &running, &size) == noErr && running) return;
  } else if ([input matchesDevice]) return;
  input->_failure(@"inputDeviceChanged");
}

- (NSString *)prepare:(NSString *)uid channel:(NSUInteger)channel
              receive:(InputBufferHandler)receive failure:(InputErrorHandler)failure {
  AudioDeviceID device = resolveInputDevice(uid);
  if (device == kAudioObjectUnknown) return @"inputDeviceUnavailable";
  _channels = inputChannelCount(device);
  _uid = inputDeviceUID(device);
  if (!_channels || !_uid.length) return @"inputDeviceUnavailable";
  if (channel < 1 || channel > _channels) return @"inputChannelUnavailable";
  _failure = [failure copy];

  AudioObjectPropertyAddress address = {kAudioDevicePropertyNominalSampleRate,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &rate) != noErr || rate <= 0)
    return @"inputFormatUnavailable";
  AVAudioChannelLayout *layout = [[AVAudioChannelLayout alloc]
      initWithLayoutTag:kAudioChannelLayoutTag_DiscreteInOrder | _channels];
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
      sampleRate:rate interleaved:YES channelLayout:layout];
  if (!format) return @"inputFormatUnavailable";
  UInt32 frameBytes = format.streamDescription->mBytesPerFrame;
  AVAudioFrameCount frames = (AVAudioFrameCount)ceil(rate * 0.02);
  AVAudioPCMBuffer *pcm = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:frames];
  if (!pcm) return @"inputFormatUnavailable";
  dispatch_queue_t callbacks = dispatch_queue_create("meeting.capture.input", DISPATCH_QUEUE_SERIAL);
  __weak DeviceInput *owner = self;
  __block double sampleOrigin = NAN, nextTime = NAN;
  OSStatus status = AudioQueueNewInputWithDispatchQueue(&_queue, format.streamDescription, 0, callbacks,
      ^(AudioQueueRef queue, AudioQueueBufferRef buffer, const AudioTimeStamp *time,
        UInt32 packets, const AudioStreamPacketDescription *descriptions) {
        @autoreleasepool {
          if (!owner.accepting) return;
          UInt32 bytes = buffer->mAudioDataByteSize;
          if (bytes > frames * frameBytes || bytes % frameBytes) { failure(@"inputFormatUnavailable"); return; }
          if (bytes) {
            pcm.frameLength = bytes / frameBytes;
            memcpy(pcm.mutableAudioBufferList->mBuffers[0].mData, buffer->mAudioData, bytes);
            double stamp = nextTime;
            if (time->mFlags & kAudioTimeStampHostTimeValid)
              stamp = [AVAudioTime secondsForHostTime:time->mHostTime];
            else if (isnan(stamp))
              stamp = NSProcessInfo.processInfo.systemUptime - pcm.frameLength / rate;
            if (time->mFlags & kAudioTimeStampSampleTimeValid) {
              if (isnan(sampleOrigin)) sampleOrigin = stamp - time->mSampleTime / rate;
              stamp = sampleOrigin + time->mSampleTime / rate;
            }
            nextTime = stamp + pcm.frameLength / rate;
            receive(pcm, stamp);
          }
          if (AudioQueueEnqueueBuffer(queue, buffer, 0, NULL) != noErr) failure(@"inputDeviceChanged");
        }
      });
  if (status != noErr) return @"inputDeviceUnavailable";
  CFStringRef selected = (__bridge CFStringRef)_uid;
  if (AudioQueueSetProperty(_queue, kAudioQueueProperty_CurrentDevice, &selected, sizeof(selected)) != noErr ||
      ![self matchesDevice]) return @"inputDeviceUnavailable";
  if (AudioQueueSetProperty(_queue, kAudioQueueProperty_ChannelLayout, layout.layout,
                            offsetof(AudioChannelLayout, mChannelDescriptions)) != noErr)
    return @"inputFormatUnavailable";
  for (unsigned i = 0; i < 6; ++i) {
    AudioQueueBufferRef buffer;
    if (AudioQueueAllocateBuffer(_queue, frames * frameBytes, &buffer) != noErr ||
        AudioQueueEnqueueBuffer(_queue, buffer, 0, NULL) != noErr) return @"inputFormatUnavailable";
  }
  return nil;
}

- (BOOL)start {
  self.accepting = YES;
  if (AudioQueueStart(_queue, NULL) != noErr) {
    self.accepting = NO;
    return NO;
  }
  for (NSNumber *key in @[@(kAudioQueueProperty_CurrentDevice), @(kAudioQueueDeviceProperty_NumberChannels),
                           @(kAudioQueueProperty_IsRunning)])
    AudioQueueAddPropertyListener(_queue, key.unsignedIntValue, queueChanged, (__bridge void *)self);
  return [self matchesDevice];
}

- (void)dealloc {
  _accepting = NO;
  if (_queue) AudioQueueDispose(_queue, true);
}
@end

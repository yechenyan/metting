#import "../modules/speech/capture/macos/AudioInputs.h"
#import <math.h>

// Distinct constant signals expose both channel swaps and accidental downmixes.
static BOOL verifyChannel(BOOL interleaved, NSUInteger selected, double rate) {
  AVAudioChannelLayout *layout = [[AVAudioChannelLayout alloc]
      initWithLayoutTag:kAudioChannelLayoutTag_DiscreteInOrder | 3];
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
      sampleRate:rate interleaved:interleaved channelLayout:layout];
  if (!format) return NO;
  AVAudioFormat *target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
      sampleRate:16000 channels:1 interleaved:NO];
  AVAudioPCMBuffer *source = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:4800];
  source.frameLength = source.frameCapacity;
  float signals[] = {-0.5f, 0.125f, 0.75f};
  for (NSUInteger c = 0; c < 3; ++c)
    for (NSUInteger frame = 0; frame < source.frameLength; ++frame)
      source.floatChannelData[c][frame * source.stride] = signals[c];
  if (monoConverter(format, target, 0) || monoConverter(format, target, 4)) return NO;
  AVAudioConverter *converter = monoConverter(format, target, selected);
  AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:target frameCapacity:4800];
  __block BOOL sent = NO;
  NSError *error = nil;
  [converter convertToBuffer:output error:&error withInputFromBlock:
      ^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *status) {
        *status = sent ? AVAudioConverterInputStatus_EndOfStream : AVAudioConverterInputStatus_HaveData;
        if (sent) return nil;
        sent = YES;
        return source;
      }];
  if (error || output.frameLength < 1000) return NO;
  for (NSUInteger frame = 200; frame < output.frameLength - 200; ++frame)
    if (fabs(output.int16ChannelData[0][frame] - signals[selected - 1] * 32768) > 2) return NO;
  return YES;
}

int main(void) {
  @autoreleasepool {
    for (NSUInteger c = 1; c <= 3; ++c)
      for (unsigned layout = 0; layout <= 1; ++layout)
        for (unsigned rate = 16000; rate <= 48000; rate += 32000)
          if (!verifyChannel(layout, c, rate)) {
            fprintf(stderr, "Channel %lu, layout %u, sample rate %u failed\n", (unsigned long)c, layout, rate);
            return 1;
          }
  }
  return 0;
}

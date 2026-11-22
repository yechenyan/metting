#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>

NSDictionary *audioInputCatalog(void);
AudioDeviceID resolveInputDevice(NSString *uid);
NSString *inputDeviceUID(AudioDeviceID device);
UInt32 inputChannelCount(AudioDeviceID device);
AVAudioConverter *monoConverter(AVAudioFormat *input, AVAudioFormat *output,
                                NSUInteger channel);

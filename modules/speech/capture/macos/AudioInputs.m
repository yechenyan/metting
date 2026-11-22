#import "AudioInputs.h"

static const AudioObjectPropertyScope global = kAudioObjectPropertyScopeGlobal;
static const AudioObjectPropertyScope input = kAudioObjectPropertyScopeInput;

static id objectProperty(AudioObjectID device, AudioObjectPropertySelector key,
                         AudioObjectPropertyScope scope, UInt32 element) {
  AudioObjectPropertyAddress addr = {key, scope, element};
  CFTypeRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, &value) != noErr)
    return nil;
  return CFBridgingRelease(value);
}

static NSMutableData *propertyData(AudioObjectID device, AudioObjectPropertySelector key,
                                   AudioObjectPropertyScope scope) {
  AudioObjectPropertyAddress addr = {key, scope, kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size) != noErr || !size)
    return nil;
  NSMutableData *data = [NSMutableData dataWithLength:size];
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, data.mutableBytes) != noErr)
    return nil;
  data.length = size;
  return data;
}

AudioDeviceID resolveInputDevice(NSString *uid) {
  AudioObjectPropertyAddress addr = {
    uid.length ? kAudioHardwarePropertyTranslateUIDToDevice : kAudioHardwarePropertyDefaultInputDevice,
    global, kAudioObjectPropertyElementMain
  };
  CFStringRef qualifier = (__bridge CFStringRef)uid;
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr,
      uid.length ? sizeof(qualifier) : 0, uid.length ? &qualifier : NULL, &size, &device);
  return status == noErr ? device : kAudioObjectUnknown;
}

UInt32 inputChannelCount(AudioDeviceID device) {
  NSData *data = propertyData(device, kAudioDevicePropertyStreamConfiguration, input);
  const AudioBufferList *buffers = data.bytes;
  UInt32 channels = 0;
  for (UInt32 i = 0; buffers && i < buffers->mNumberBuffers; ++i)
    channels += buffers->mBuffers[i].mNumberChannels;
  return channels;
}

NSString *inputDeviceUID(AudioDeviceID device) {
  return objectProperty(device, kAudioDevicePropertyDeviceUID, global, 0);
}

static NSArray<NSString *> *channelNames(AudioDeviceID device, UInt32 count) {
  NSArray *members = objectProperty(device, kAudioAggregateDevicePropertyFullSubDeviceList, global, 0);
  NSMutableArray *labels = [NSMutableArray arrayWithCapacity:count];
  for (NSString *uid in members) {
    AudioDeviceID member = resolveInputDevice(uid);
    if (member == kAudioObjectUnknown) continue;
    NSString *name = objectProperty(member, kAudioObjectPropertyName, global, 0);
    UInt32 channels = inputChannelCount(member);
    for (UInt32 n = 0; n < channels; ++n)
      [labels addObject:name ?: @""];
  }
  if (labels.count == count) return labels;
  [labels removeAllObjects];
  for (UInt32 channel = 1; channel <= count; ++channel)
    [labels addObject:objectProperty(device, kAudioObjectPropertyElementName, input, channel) ?: @""];
  return labels;
}

NSDictionary *audioInputCatalog(void) {
  NSData *data = propertyData(kAudioObjectSystemObject, kAudioHardwarePropertyDevices, global);
  if (!data) return nil;
  const AudioDeviceID *ids = data.bytes;
  AudioDeviceID defaultDevice = resolveInputDevice(@"");
  NSString *defaultUID = @"";
  NSMutableArray *devices = [NSMutableArray new];
  for (NSUInteger n = 0; n < data.length / sizeof(AudioDeviceID); ++n) {
    AudioDeviceID device = ids[n];
    UInt32 channels = inputChannelCount(device);
    if (!channels) continue;
    NSString *uid = inputDeviceUID(device);
    if (!uid.length) continue;
    NSString *name = objectProperty(device, kAudioObjectPropertyName, global, 0);
    if (device == defaultDevice) defaultUID = uid;
    [devices addObject:@{@"id": uid, @"name": name ?: uid,
                         @"channels": channelNames(device, channels)}];
  }
  return @{@"defaultId": defaultUID, @"devices": devices};
}

AVAudioConverter *monoConverter(AVAudioFormat *inputFormat, AVAudioFormat *output,
                                NSUInteger channel) {
  if (channel < 1 || channel > inputFormat.channelCount) return nil;
  AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:inputFormat toFormat:output];
  converter.channelMap = @[@(channel - 1)];
  return converter;
}

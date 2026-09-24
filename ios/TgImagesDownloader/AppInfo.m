#import <React/RCTBridgeModule.h>
@import SystemConfiguration;

/**
 * iOS counterpart of the Android AppInfoModule. Reads the app's display name
 * and version from Info.plist so the 关于 section shows the real store version
 * on both platforms.
 *
 *   CFBundleShortVersionString -> version     (marketing version)
 *   CFBundleVersion            -> buildNumber (build)
 *
 * Methods:
 *   - getAppInfo(): Promise<{ appName, packageName, version, buildNumber }>
 *   - getNetworkType(): Promise<'wifi'|'cellular'|'none'|'unknown'>
 */
@interface AppInfo : NSObject <RCTBridgeModule>
@end

@implementation AppInfo

RCT_EXPORT_MODULE(AppInfo);

RCT_EXPORT_METHOD(getAppInfo
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  @try {
    NSBundle *bundle = [NSBundle mainBundle];
    NSDictionary *info = [bundle infoDictionary];
    NSString *version = info[@"CFBundleShortVersionString"] ?: @"";
    NSString *build = info[@"CFBundleVersion"] ?: @"";
    NSString *name =
        info[@"CFBundleDisplayName"] ?: info[@"CFBundleName"] ?: @"";
    resolve(@{
      @"appName" : name,
      @"packageName" : [bundle bundleIdentifier] ?: @"",
      @"version" : version,
      @"buildNumber" : build,
    });
  } @catch (NSException *e) {
    reject(@"ERR_APP_INFO", e.reason ?: @"failed to read app info", nil);
  }
}

/**
 * Report whether the current internet path is Wi-Fi or cellular, mirroring the
 * Android implementation. Uses SCNetworkReachability, whose IsWWAN flag is
 * exactly the "cellular vs Wi-Fi" distinction we need. Resolves 'unknown' on
 * failure so the JS side never blocks a download on this check.
 */
RCT_EXPORT_METHOD(getNetworkType
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  SCNetworkReachabilityRef ref =
      SCNetworkReachabilityCreateWithName(NULL, "apple.com");
  if (ref == NULL) {
    resolve(@"unknown");
    return;
  }
  SCNetworkReachabilityFlags flags = 0;
  BOOL ok = SCNetworkReachabilityGetFlags(ref, &flags);
  CFRelease(ref);
  if (!ok) {
    resolve(@"unknown");
    return;
  }
  if ((flags & kSCNetworkReachabilityFlagsReachable) == 0) {
    resolve(@"none");
    return;
  }
  BOOL isWWAN = (flags & kSCNetworkReachabilityFlagsIsWWAN) != 0;
  resolve(isWWAN ? @"cellular" : @"wifi");
}

@end

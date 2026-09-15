#import <React/RCTBridgeModule.h>

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

@end

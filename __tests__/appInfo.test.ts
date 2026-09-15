import { NativeModules } from 'react-native';
import {
  getAppInfo,
  isAppInfoAvailable,
  normalizeAppInfo,
  type AppInfo,
} from '../src/services/appInfo';

const EMPTY: AppInfo = {
  appName: '',
  packageName: '',
  version: '',
  buildNumber: '',
};

const nativeModules = NativeModules as Record<string, unknown>;

describe('services/appInfo', () => {
  const original = nativeModules.AppInfo;

  afterEach(() => {
    nativeModules.AppInfo = original;
  });

  it('normalizeAppInfo coerces missing/blank fields to empty strings', () => {
    expect(normalizeAppInfo(undefined)).toEqual(EMPTY);
    expect(normalizeAppInfo(null)).toEqual(EMPTY);
    expect(normalizeAppInfo({ version: '1.0.2' })).toEqual({
      ...EMPTY,
      version: '1.0.2',
    });
  });

  it('getAppInfo reads and normalizes the native payload', async () => {
    nativeModules.AppInfo = {
      getAppInfo: async () => ({
        appName: '网页图片批量下载器',
        packageName: 'com.acstd.tgimagesdownloader',
        version: '1.0.2',
        buildNumber: '2',
      }),
    };

    expect(isAppInfoAvailable()).toBe(true);
    await expect(getAppInfo()).resolves.toEqual({
      appName: '网页图片批量下载器',
      packageName: 'com.acstd.tgimagesdownloader',
      version: '1.0.2',
      buildNumber: '2',
    });
  });

  it('getAppInfo resolves to empties when the native module is not linked', async () => {
    nativeModules.AppInfo = undefined;
    expect(isAppInfoAvailable()).toBe(false);
    await expect(getAppInfo()).resolves.toEqual(EMPTY);
  });

  it('getAppInfo swallows native rejections', async () => {
    nativeModules.AppInfo = {
      getAppInfo: async () => {
        throw new Error('boom');
      },
    };
    await expect(getAppInfo()).resolves.toEqual(EMPTY);
  });
});

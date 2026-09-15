import { appRootFromSaveDir, isSharedSaveFolder } from '../src/utils/saveDir';

describe('utils/saveDir', () => {
  describe('appRootFromSaveDir', () => {
    it('strips a per-article subfolder', () => {
      expect(appRootFromSaveDir('Pictures/TelegraphDownloader/MyTitle')).toBe(
        'Pictures/TelegraphDownloader',
      );
    });

    it('handles the Download root (storageType=downloads)', () => {
      expect(appRootFromSaveDir('Download/TelegraphDownloader/x')).toBe(
        'Download/TelegraphDownloader',
      );
    });

    it('falls back to the Pictures root for unexpected values', () => {
      expect(appRootFromSaveDir('')).toBe('Pictures/TelegraphDownloader');
      expect(appRootFromSaveDir('DCIM/Camera')).toBe(
        'Pictures/TelegraphDownloader',
      );
    });
  });

  describe('isSharedSaveFolder', () => {
    it('treats the app base folder (with or without trailing slash) as shared', () => {
      expect(isSharedSaveFolder('Pictures/TelegraphDownloader')).toBe(true);
      expect(isSharedSaveFolder('Pictures/TelegraphDownloader/')).toBe(true);
      expect(isSharedSaveFolder('Download/TelegraphDownloader')).toBe(true);
    });

    it('treats a per-article subfolder as NOT shared', () => {
      expect(isSharedSaveFolder('Pictures/TelegraphDownloader/Title')).toBe(
        false,
      );
    });

    it('treats empty/unset as shared', () => {
      expect(isSharedSaveFolder('')).toBe(true);
      expect(isSharedSaveFolder(undefined)).toBe(true);
      expect(isSharedSaveFolder(null)).toBe(true);
    });
  });
});

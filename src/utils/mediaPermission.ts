import { useEffect, useState } from 'react';
import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { t } from '../i18n';

/**
 * Media read permission for the 下载记录详情 grid.
 *
 * Images the app saved itself are always readable, but images created by
 * ANOTHER app — e.g. records imported from a different install of this app,
 * whose `content://media/...` URIs point at files owned by that install —
 * require a media read permission on Android:
 *   - API 33+: READ_MEDIA_IMAGES (Android 14+ may grant only partial access
 *     via READ_MEDIA_VISUAL_USER_SELECTED when the user picks "Select photos")
 *   - API <= 32: READ_EXTERNAL_STORAGE
 *
 * iOS has no equivalent runtime permission for MediaStore-style URIs; the
 * hook is a no-op there.
 */

/** One prompt per app launch: swiping between records must not nag. */
let requestedThisLaunch = false;

/** True when the app may read images created by other apps. */
async function canReadOthersMedia(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 33) {
      const full = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
      );
      if (full) return true;
      // Android 14+ partial access: the user selected specific photos; the
      // selected ones are readable, so treat it as granted (tiles that stay
      // unreadable keep their red × and the prompt can be retried next launch).
      return await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED,
      );
    }
    return await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
    );
  } catch {
    return false;
  }
}

/**
 * Ensures the media read permission when a screen that shows other apps'
 * images mounts. Returns a counter that increments once the permission
 * becomes available — use it in image keys so failed tiles remount and retry.
 */
export function useMediaReadPermission(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (Platform.OS !== 'android') return;
      if (await canReadOthersMedia()) return;
      if (requestedThisLaunch) return;
      requestedThisLaunch = true;

      const perm =
        Platform.Version >= 33
          ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
          : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;
      try {
        await PermissionsAndroid.request(perm);
      } catch {
        // fall through to the re-check below
      }
      if (!mounted) return;

      if (await canReadOthersMedia()) {
        // Remount image tiles so the ones that already errored retry.
        setTick(v => v + 1);
        return;
      }
      Alert.alert(t('history.mediaPerm.title'), t('history.mediaPerm.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('history.mediaPerm.goSettings'),
          onPress: () => Linking.openSettings().catch(() => undefined),
        },
      ]);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return tick;
}

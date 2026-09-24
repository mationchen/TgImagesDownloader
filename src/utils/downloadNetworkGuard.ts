import { Alert } from 'react-native';
import { getNetworkType } from '../services/appInfo';
import { t } from '../i18n';

/**
 * Warn before a download starts when the device is not on Wi-Fi.
 *
 * Downloads are this app's whole purpose and a batch can move hundreds of
 * megabytes, so silently falling back to mobile data is a real cost for the
 * user. Resolves `true` when the download may proceed (Wi-Fi, ethernet, or the
 * transport could not be determined) and `false` when the user cancelled.
 *
 * Android reports the underlying Wi-Fi even while a VPN owns the active
 * network (see AppInfoModule.getNetworkType), so a proxy app doesn't turn a
 * Wi-Fi connection into a false warning.
 */
export async function confirmDownloadWithoutWifi(): Promise<boolean> {
  const type = await getNetworkType();
  // Never block on an undetectable transport (module missing / platform not
  // rebuilt): the warning is a courtesy, not a gate.
  if (type === 'wifi' || type === 'ethernet' || type === 'unknown') return true;

  return new Promise<boolean>(resolve => {
    Alert.alert(
      t('network.wifiWarning.title'),
      type === 'none'
        ? t('network.wifiWarning.bodyOffline')
        : t('network.wifiWarning.body'),
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => resolve(false),
        },
        {
          text: t('network.wifiWarning.continue'),
          onPress: () => resolve(true),
        },
      ],
      {
        // Back button / tap-outside must behave like "cancel": the download
        // only ever starts after an explicit confirmation.
        cancelable: false,
        onDismiss: () => resolve(false),
      },
    );
  });
}

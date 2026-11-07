import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, StyleSheet, Text } from 'react-native';
import { ImageTrashScreen } from '../src/screens/ImageTrashScreen';
import { listTrashedImages, restoreTrashedImage } from '../src/services/historyService';
import { purgeTrashedImages } from '../src/services/imageTrashService';
import { t } from '../src/i18n';

jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('react-native/Libraries/Modal/Modal', () => ({ __esModule: true, default: require('react-native').View }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: () => void) => require('react').useEffect(callback, [callback]) }));
jest.mock('../src/utils/mediaPermission', () => ({ useMediaReadPermission: () => 0 }));
jest.mock('../src/components/ZoomableImage', () => ({ ZoomableImage: 'ZoomableImage' }));
jest.mock('../src/services/historyService', () => ({ listTrashedImages: jest.fn(), restoreTrashedImage: jest.fn() }));
jest.mock('../src/services/imageTrashService', () => ({ purgeTrashedImages: jest.fn() }));

const items = [1, 2].map(n => ({ uri: `content://image/${n}`, title: `Gallery ${n}`, recordId: 1, url: '', trashedAt: 1 }));
let tree: TestRenderer.ReactTestRenderer;
beforeEach(async () => {
  jest.resetAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  (listTrashedImages as jest.Mock).mockResolvedValue(items);
  await act(async () => { tree = TestRenderer.create(<ImageTrashScreen />); });
});
afterEach(async () => { await act(async () => tree.unmount()); jest.restoreAllMocks(); });

it('opens the selected exact URI in a full-width viewer and supports zoom without page swiping', async () => {
  const buttons = tree.root.findAll(node => typeof node.props.onPress === 'function' && node.props.accessibilityRole === 'imagebutton');
  await act(async () => buttons[buttons.length - 1].props.onPress());
  const image = tree.root.findAll(node => String(node.type) === 'ZoomableImage' && node.props.uri === 'content://image/2')[0];
  expect(image).toBeDefined();
  let container = image.parent;
  while (container && StyleSheet.flatten(container.props.style)?.width !== '100%') container = container.parent;
  expect(StyleSheet.flatten(container?.props.style)).toMatchObject({ flex: 1, width: '100%' });
  await act(async () => image.props.onZoomChange(true));
  expect(tree.root.findAll(node => node.props.horizontal && node.props.pagingEnabled && node.props.scrollEnabled === false).length).toBeGreaterThan(0);
  // A slow swipe may not generate momentum; its end-drag must update the selected image too.
  const pager = tree.root.findAll(node => node.props.horizontal && typeof node.props.onScrollEndDrag === 'function')[0];
  await act(async () => pager.props.onScrollEndDrag({ nativeEvent: { contentOffset: { x: 0 } } }));
  expect(tree.root.findAllByType(Text).some(node => node.props.children === t('preview.viewerIndex', { current: 1, total: 2 }))).toBe(true);
});

it('clear requires confirmation and reports / retains partial failures', async () => {
  const clear = tree.root.findAll(node => typeof node.props.onPress === 'function').find(node => node.findAll(text => text.props.children === t('imageTrash.clear')).length)!;
  await act(async () => clear.props.onPress());
  expect(purgeTrashedImages).not.toHaveBeenCalled();
  (purgeTrashedImages as jest.Mock).mockResolvedValue({ deleted: 1, failed: 1 });
  (listTrashedImages as jest.Mock).mockResolvedValue([items[1]]);
  const action = (Alert.alert as jest.Mock).mock.calls[0][2][1];
  await act(async () => { await action.onPress(); });
  expect(purgeTrashedImages).toHaveBeenCalledWith(items);
  expect(Alert.alert).toHaveBeenLastCalledWith(t('imageTrash.clear'), t('imageTrash.clearResult', { deleted: 1, failed: 1 }));
  expect(tree.root.findAllByType(Text).some(node => node.props.children === t('imageTrash.count', { count: 1 }))).toBe(true);
});

it('restores only the chosen URI', async () => {
  const restore = tree.root.findAll(node => typeof node.props.onPress === 'function').find(node => node.findAll(text => text.props.children === t('imageTrash.restore')).length)!;
  await act(async () => { await restore.props.onPress(); });
  expect(restoreTrashedImage).toHaveBeenCalledWith('content://image/1');
});

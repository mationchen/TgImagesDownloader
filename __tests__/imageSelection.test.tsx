import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, Text } from 'react-native';
import { ImageSelectionModal } from '../src/components/ImageSelectionModal';
import { t } from '../src/i18n';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: require('react-native').View,
}));

let tree: TestRenderer.ReactTestRenderer;
const uris = Array.from({ length: 150 }, (_, i) => `content://image/${i}`);
const onMove = jest.fn();
const onClose = jest.fn();
beforeEach(async () => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  await act(async () => { tree = TestRenderer.create(<ImageSelectionModal uris={uris} onMove={onMove} onClose={onClose} />); });
});
afterEach(async () => { await act(async () => tree.unmount()); jest.restoreAllMocks(); });
async function press(label: string) {
  const button = tree.root.findAll(node => typeof node.props.onPress === 'function').find(node =>
    node.findAll(text => text.props.children === label).length > 0);
  expect(button).toBeDefined();
  await act(async () => { button!.props.onPress(); });
}

it('select all applies to the entire gallery, not just virtualized visible tiles, and requires confirmation', async () => {
  await press(t('preview.selectAll'));
  await press(t('imageTrash.move'));
  expect(onMove).not.toHaveBeenCalled();
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect(buttons[0].style).toBe('cancel');
  await act(async () => { await buttons[1].onPress(); });
  expect(onMove).toHaveBeenCalledWith(uris);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('invert selection and deselect all work across all gallery items', async () => {
  const checkbox = tree.root.findAll(node => node.props.accessibilityRole === 'checkbox' && typeof node.props.onPress === 'function')[0];
  await act(async () => checkbox.props.onPress());
  await press(t('preview.invertSelection'));
  expect(tree.root.findAllByType(Text).some(text => text.props.children === t('imageTrash.selectionCount', { selected: 149, total: 150 }))).toBe(true);
  await press(t('preview.deselectAll'));
  expect(tree.root.findAllByType(Text).some(text => text.props.children === t('imageTrash.selectionCount', { selected: 0, total: 150 }))).toBe(true);
});

it('cancel never writes, and a failed move keeps the selection open', async () => {
  await press(t('common.cancel'));
  expect(onMove).not.toHaveBeenCalled();
  onClose.mockClear();
  onMove.mockRejectedValueOnce(new Error('disk full'));
  await press(t('preview.selectAll'));
  await press(t('imageTrash.move'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  await act(async () => { await buttons[1].onPress(); });
  expect(onClose).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenLastCalledWith(t('imageTrash.error'));
});

import { finishPurgingTrashedImage, listTrashedImages, type TrashedImage } from '../src/services/historyService';
import { TelegraphDownloader } from '../src/services/nativeDownloader';
import { purgeTrashedImages } from '../src/services/imageTrashService';

jest.mock('../src/services/historyService', () => ({ finishPurgingTrashedImage: jest.fn(), listTrashedImages: jest.fn() }));
jest.mock('../src/services/nativeDownloader', () => ({ TelegraphDownloader: { deleteImageForTrash: jest.fn() } }));
const item = (uri: string): TrashedImage => ({ uri, recordId: 1, title: '', url: '', trashedAt: 1 });
beforeEach(() => {
  jest.resetAllMocks();
  (listTrashedImages as jest.Mock).mockResolvedValue([item('content://1'), item('content://2'), item('content://3'), item('https://img.test/1.jpg')]);
});

it('keeps failures / permission rejection while continuing other images', async () => {
  (TelegraphDownloader!.deleteImageForTrash as jest.Mock)
    .mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('permission'));
  expect(await purgeTrashedImages([item('content://1'), item('content://2'), item('content://3')]))
    .toEqual({ deleted: 1, failed: 2 });
  expect(finishPurgingTrashedImage).toHaveBeenCalledTimes(1);
  expect(finishPurgingTrashedImage).toHaveBeenCalledWith('content://1');
});

it('does not call native deletion for remote-only images', async () => {
  expect(await purgeTrashedImages([item('https://img.test/1.jpg')])).toEqual({ deleted: 1, failed: 0 });
  expect(TelegraphDownloader!.deleteImageForTrash).not.toHaveBeenCalled();
});

it('database failure is reported as failure, never as a completed clear', async () => {
  (TelegraphDownloader!.deleteImageForTrash as jest.Mock).mockResolvedValue(true);
  (finishPurgingTrashedImage as jest.Mock).mockRejectedValue(new Error('disk full'));
  expect(await purgeTrashedImages([item('content://1')])).toEqual({ deleted: 0, failed: 1 });
});

it('does not delete a URI already restored after the confirmation snapshot was taken', async () => {
  (listTrashedImages as jest.Mock).mockResolvedValue([]);
  expect(await purgeTrashedImages([item('content://1')])).toEqual({ deleted: 0, failed: 1 });
  expect(TelegraphDownloader!.deleteImageForTrash).not.toHaveBeenCalled();
});

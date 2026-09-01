/* eslint-disable no-undef */
// Jest setup file. Runs before each test suite.

// Mock react-native-blob-util so its module-load-time `new NativeEventEmitter()`
// doesn't blow up under the JSDOM / jest environment where no native module
// is registered. We only need a structural stand-in for the test render
// smoke check; full behaviour is exercised on-device.
jest.mock('react-native-blob-util', () => {
  const noop = () => undefined;
  const pathLike = {CacheDir: '/tmp/cache', DocumentDir: '/tmp/docs'};
  const fsApi = {
    dirs: pathLike,
    stat: jest.fn(() => Promise.resolve({size: 0, type: 'file'})),
    unlink: jest.fn(() => Promise.resolve()),
    exists: jest.fn(() => Promise.resolve(false)),
    mkdir: jest.fn(() => Promise.resolve()),
    isDir: jest.fn(() => Promise.resolve(false)),
    writeFile: jest.fn(() => Promise.resolve()),
    readFile: jest.fn(() => Promise.resolve('')),
    appendFile: jest.fn(() => Promise.resolve(0)),
    writeStream: jest.fn(() =>
      Promise.resolve({write: noop, close: noop}),
    ),
    readStream: jest.fn(() => Promise.resolve({open: noop, onData: noop, onEnd: noop, onError: noop})),
  };
  const fetchApi = () => ({
    info: () => ({status: 200, headers: {}}),
    path: () => '/tmp/mock.jpg',
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({}),
    flush: noop,
    progress: noop,
  });
  return {
    __esModule: true,
    default: {
      config: () => ({fetch: fetchApi}),
      fetch: fetchApi,
      fs: fsApi,
      wrap: jest.fn(),
    },
    config: () => ({fetch: fetchApi}),
    fetch: fetchApi,
    fs: fsApi,
    wrap: jest.fn(),
  };
});

// Mock op-sqlite so its native JSI install() doesn't run under Jest. Tests
// that exercise migration/CRUD logic provide their own fake DB via
// `open`/`openSync`, so we only need the module shape here.
jest.mock('@op-engineering/op-sqlite', () => ({
  __esModule: true,
  open: jest.fn(),
  openSync: jest.fn(),
  openRemote: jest.fn(),
  openV2: jest.fn(),
}));

// Mock @react-native-clipboard/clipboard (native module; no-op in Jest).
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    getString: jest.fn(() => Promise.resolve('')),
    setString: jest.fn(() => Promise.resolve(true)),
    hasString: jest.fn(() => Promise.resolve(false)),
  },
}));
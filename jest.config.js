/**
 * Extend the default RN jest preset to also transform @react-navigation/*
 * (shipped as ESM-only) so `npm test` can import our navigator without
 * throwing "Unexpected token 'export'".
 */
const preset = require('@react-native/jest-preset');

module.exports = {
  ...preset,
  setupFiles: [...(preset.setupFiles ?? []), require.resolve('./jest.setup.js')],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-blob-util)/)',
  ],
};
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  minify: process.env.NODE_ENV === 'production',
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/inject.ts'],
    outfile: 'dist/inject.js',
  }),
  build({
    ...shared,
    entryPoints: ['src/content.ts'],
    outfile: 'dist/content.js',
  }),
  build({
    ...shared,
    entryPoints: ['src/background.ts'],
    outfile: 'dist/background.js',
  }),
]);

console.log('Extension bundled to dist/');

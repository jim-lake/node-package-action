import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import esbuild from 'rollup-plugin-esbuild';

export default {
  input: 'src/node-package-action.ts',
  output: {
    file: 'dist/node-package-action.mjs',
    format: 'esm',
    sourcemap: false,
  },
  // Internalize every dependency: only Node's own builtins stay external.
  external: (id) => id.startsWith('node:'),
  plugins: [
    nodeResolve({ preferBuiltins: true, exportConditions: ['node'] }),
    commonjs(),
    json(),
    esbuild({
      target: 'node24',
      minify: false,
      sourceMap: false,
      tsconfig: './tsconfig.json',
    }),
  ],
};

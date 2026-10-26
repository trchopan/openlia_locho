import { defineConfig } from 'vite';

export default defineConfig({
  base: '/__locho/',
  build: {
    sourcemap: false,
    rollupOptions: {
      input: { index: 'index.html', sw: 'src/sw.ts' },
      output: {
        entryFileNames: (chunk) => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});

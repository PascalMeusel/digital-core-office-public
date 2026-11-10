import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  // Suite production serves Projects below /agile/; local development stays at /.
  base: process.env.VITE_BASE_PATH ?? (command === 'build' ? '/agile/' : '/'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4197',
    },
  },
}))

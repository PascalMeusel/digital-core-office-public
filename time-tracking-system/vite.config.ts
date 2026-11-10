import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Suite production serves Time below /time/; local development stays at /.
  base: process.env.VITE_BASE_PATH ?? (command === 'build' ? '/time/' : '/'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: true,
  },
}))

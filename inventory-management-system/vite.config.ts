import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // Production builds are hosted behind the shared suite at /inventory/.
  // Keep the development server at /, while making a plain `npm run build`
  // safe for the canonical deployment even when no build environment is set.
  base: process.env.VITE_BASE_PATH ?? (command === 'build' ? '/inventory/' : '/'),
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: true,
  },
}))

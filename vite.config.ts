import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// For GitHub Pages project sites (https://<user>.github.io/<repo>/), build with
// VITE_BASE=/<repo>/ so asset URLs resolve. Local dev/preview uses "/".
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
})

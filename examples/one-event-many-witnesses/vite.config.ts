import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { ad4mDemoPlugin } from './vite-plugin-ad4m.ts'

export default defineConfig({
  plugins: [solid(), tailwindcss(), ad4mDemoPlugin()],
  server: {
    host: true
  }
})

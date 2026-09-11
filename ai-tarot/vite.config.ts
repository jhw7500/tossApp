import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import aitDevtools from "@apps-in-toss/devtools/unplugin";
import { readFileSync } from 'node:fs'

export default defineConfig({
  plugins: [{
    name: 'tarororo-lan-crypto',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{ tag: 'script', injectTo: 'head-prepend', children: readFileSync(new URL('./dev/lan-crypto.js', import.meta.url), 'utf8') }],
    },
  }, aitDevtools.vite(), react()],
  optimizeDeps: {
    // TDS의 사전 번들에 실제 SDK가 포함되면 브라우저용 mock을 우회한다.
    exclude: [
      '@apps-in-toss/web-framework',
      '@apps-in-toss/webview-bridge',
    ],
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.TARORORO_API_PORT || '3100'}`,
        changeOrigin: false,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})

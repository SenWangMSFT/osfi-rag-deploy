import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';

let cliToken: { token: string; expires: number } | null = null;

/** There's no sign-in locally: your az login identity's Azure AI Search token stands in for the user's. */
function azCliToken(): string {
  if (!cliToken || cliToken.expires - Date.now() < 5 * 60_000) {
    const output = execSync(
      'az account get-access-token --resource https://search.azure.com --query "{token:accessToken,expires:expires_on}" -o json',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const { token, expires } = JSON.parse(output) as { token: string; expires: number };
    cliToken = { token, expires: Number(expires) * 1000 };
  }
  return cliToken.token;
}

export default defineConfig(({ mode }) => {
  // Read by the dev server only; nothing without a VITE_ prefix reaches the browser bundle.
  const env = loadEnv(mode, process.cwd(), '');
  const apiBaseUrl = env.API_BASE_URL || 'http://localhost:7071';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiBaseUrl,
          changeOrigin: true,
          headers: env.API_KEY ? { 'x-functions-key': env.API_KEY } : undefined,
          configure: (proxy) => {
            if (env.LOCAL_USER_TOKEN !== 'az') return;
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('x-search-user-token', azCliToken()));
          },
        },
      },
    },
  };
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest is configured for a Node test environment with the repository's
 * TypeScript path aliases so that `import ... from '@/db/client'` resolves in
 * unit tests exactly as it does in the app.
 *
 * `passWithNoTests` is intentionally NOT set: a missing test file must fail
 * `npm run test:unit` rather than silently passing.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});

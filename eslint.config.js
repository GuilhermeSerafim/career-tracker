import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**', 'node_modules/**', '.private/**', 'reports/**', '.worktrees/**', 'supabase/.temp/**']),
  { files: ['**/*.{js,mjs,ts,tsx}'], extends: [js.configs.recommended, ...tseslint.configs.recommended] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'pg', message: 'Acesso PostgreSQL pertence ao servidor.' },
          { name: 'echarts', message: 'Carregue ECharts sob demanda na área de análises.' },
        ],
        patterns: [{ group: ['node:*', '**/server/**', '**/api/**', '**/scripts/**', 'echarts/*'], message: 'Preserve os limites do frontend e o carregamento sob demanda de gráficos.' }],
      }],
      'no-restricted-globals': ['error', { name: 'process', message: 'Use apenas configuração pública explícita no frontend.' }],
      'no-restricted-syntax': ['error',
        { selector: "ImportExpression[source.value=/^(node:|pg$)/]", message: 'Módulos de servidor não podem entrar no frontend.' },
        { selector: "ImportExpression[source.value=/\\/(server|scripts|api)\\//]", message: 'Preserve o limite entre navegador e servidor.' },
      ],
    },
  },
  { files: ['server/**/*.ts', 'api/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tests/**/*.ts', '*.config.{js,ts}'], languageOptions: { globals: globals.node } },
]);

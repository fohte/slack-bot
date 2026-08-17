import { config } from '@fohte/eslint-config'

<<<<<<< before updating
export default config(
  {
    typescript: { typeChecked: true },
    opentelemetry: { enabled: true },
    errorHandling: {},
  },
  {
    ignores: ['dist/**'],
  },
  {
    files: ['**/*.test.ts', '**/_test-utils.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
)
||||||| last update
export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
  },
)
=======
export default config({
  typescript: { typeChecked: true },
  errorHandling: {},
})
>>>>>>> after updating

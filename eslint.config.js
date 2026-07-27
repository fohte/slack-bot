import { config } from '@fohte/eslint-config'

export default config(
<<<<<<< before updating
  { typescript: { typeChecked: true }, opentelemetry: { enabled: true } },
||||||| last update
  { typescript: { typeChecked: true } },
=======
>>>>>>> after updating
  {
<<<<<<< before updating
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
||||||| last update
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '../*'],
              message:
                'Please use absolute imports instead of relative imports.',
            },
          ],
        },
      ],
    },
=======
    typescript: { typeChecked: true },
    errorHandling: {},
>>>>>>> after updating
  },
)

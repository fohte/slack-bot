import { config } from '@fohte/eslint-config'

export default config(
  { typescript: { typeChecked: true } },
  {
    ignores: ['dist/**'],
  },
  {
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
  },
  {
    // @fohte/eslint-config doesn't enable no-restricted-syntax yet, so the
    // disable directives guarding these files' manual tracer.startSpan()
    // calls are (correctly, for now) flagged as unused. Remove this
    // override once the rule ships upstream.
    files: [
      'src/observability/counters.ts',
      'src/plugins/llm-agent/conversation-agent/genai-tracing-middleware.ts',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
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

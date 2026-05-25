Run /review-swarm on this changed file. It is the only change in the diff.

File: `src/utils/format.ts` (renamed a variable for clarity and extracted a constant)

```typescript
const DEFAULT_LOCALE = 'en-US';

/**
 * Format a number as USD currency.
 */
export function formatCurrency(amount: number): string {
  const formatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: 'currency',
    currency: 'USD',
  });
  return formatter.format(amount);
}

/**
 * Truncate a string to maxLength, appending an ellipsis if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + '…';
}
```

The previous version inlined the locale string `'en-US'` in `formatCurrency` and used a
single-letter parameter name `s` in `truncate`. This change extracts `DEFAULT_LOCALE` and
renames `s` → `text`. No behavior change intended.

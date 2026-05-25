Review this JavaScript function for correctness bugs. For each issue, output a line in the form `[BUG] <description>` (must-fix correctness issue) or `[SUGGESTION] <description>` (minor improvement). If there are no issues, reply exactly "No issues found."

```js
// Sums the first n elements of arr.
function sumFirstN(arr, n) {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += arr[i];
  }
  return total;
}
```

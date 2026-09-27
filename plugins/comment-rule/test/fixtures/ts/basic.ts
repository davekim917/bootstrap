const url = 'http://example.com'; // trailing note
// leading note
const s = "// not a comment";
const t = `/* not a comment ${1 /* real */} */`;
const r = /\/\/ not a comment/;
/**
 * doc block
 */
export function f() {}
/* eslint-disable no-console */
// @ts-expect-error look-alike directive carrying narration

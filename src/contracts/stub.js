const warned = new Set();

export function stubWarning(fn, owner) {
  if (warned.has(fn)) return;
  warned.add(fn);
  console.warn(
    `[STUB] ${fn} uses a fake implementation (owner: ${owner}). ` +
      'Replace it without changing the signature (see src/contracts/interfaces.js).',
  );
}

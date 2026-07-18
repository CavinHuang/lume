export function cjkNgrams(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  const chars = [...normalized];
  const grams = new Set<string>();
  for (const size of [2, 3]) {
    for (let index = 0; index + size <= chars.length; index += 1) grams.add(chars.slice(index, index + size).join(""));
  }
  if (chars.length === 1) grams.add(chars[0]!);
  return [...grams];
}

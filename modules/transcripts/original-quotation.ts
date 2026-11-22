export interface OriginalExcerpt {
  id: string;
  text: string;
}

/** Map a visible selection back to the recognizer output, including merged
 * reading turns. A selected translation resolves to the underlying speech. */
export function originalExcerpts(
  rows: readonly { id: string; raw: string }[],
  visible: readonly string[],
): OriginalExcerpt[] {
  const spoken = rows.map((row) => row.raw).join(" ");
  const candidates =
    visible.length > 1 ? [visible.join(" "), ...visible] : visible;
  const selected = candidates.find((part) => part && spoken.includes(part));
  const start = selected ? spoken.indexOf(selected) : 0;
  const end = selected ? start + selected.length : spoken.length;
  const result: OriginalExcerpt[] = [];
  let offset = 0;
  for (const row of rows) {
    const from = Math.max(0, start - offset);
    const to = Math.min(row.raw.length, end - offset);
    const text = from < to ? row.raw.slice(from, to).trim() : "";
    if (text) result.push({ id: row.id, text });
    offset += row.raw.length + 1;
  }
  return result;
}

export function limitOriginal(excerpts: OriginalExcerpt[], remaining: number) {
  const result: OriginalExcerpt[] = [];
  for (const excerpt of excerpts) {
    if (remaining <= 0) break;
    let end = Math.min(remaining, excerpt.text.length);
    if (
      end < excerpt.text.length &&
      /[\uD800-\uDBFF]/u.test(excerpt.text[end - 1])
    )
      end--;
    const text = excerpt.text.slice(0, end).trim();
    if (text) result.push({ id: excerpt.id, text });
    remaining -= end + 1;
  }
  return result;
}

export function audioFilename(stem: string, start: number, copy = 1) {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const seconds = Math.floor(start / 1000);
  const time =
    pad(Math.floor(seconds / 3600)) +
    "h" +
    pad(Math.floor(seconds / 60) % 60) +
    "m" +
    pad(seconds % 60) +
    "." +
    pad(start % 1000, 3) +
    "s";
  return stem + " - " + time + (copy > 1 ? " (" + copy + ")" : "") + ".wav";
}
export function parseAudioFilename(name: string) {
  const match =
    /^(.+) - (\d{2,})h([0-5]\d)m([0-5]\d)\.(\d{3})s(?: \((\d+)\))?\.wav$/.exec(
      name,
    );
  if (match)
    return {
      stem: match[1],
      start:
        ((Number(match[2]) * 60 + Number(match[3])) * 60 + Number(match[4])) *
          1000 +
        Number(match[5]),
      copy: Number(match[6] || 1),
    };
  const legacy = /^(\d{12,16})-[a-f0-9]{32}\.wav$/.exec(name);
  return legacy
    ? { stem: undefined, start: Number(legacy[1]), copy: 1 }
    : undefined;
}

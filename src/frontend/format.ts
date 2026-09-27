export const number = (value: number) => value.toLocaleString("en-US");
export const percent = (value: number | null) =>
  value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;

export function splitLabel(text: string): string[] {
  const words = text.split(" ");
  const lines = [""];
  for (const word of words) {
    const last = lines.length - 1;
    if (lines[last] && `${lines[last]} ${word}`.length > 10) lines.push(word);
    else lines[last] += `${lines[last] ? " " : ""}${word}`;
  }
  return lines;
}

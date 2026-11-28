export function formatNoteText(raw: string): string {
  return (raw || "").replace(/\r\n/g, "\n").trim();
}

export function formatNotePreview(raw: string): string {
  return formatNoteText(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function formatNoteLabel(raw: string): string {
  return formatNotePreview(raw).replace(/\n+/g, " ");
}

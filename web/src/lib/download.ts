/** Hands a downloaded file to the browser's save flow. */
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke after the click has been handled, so the download isn't cut off.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

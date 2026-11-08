import { api } from "./api";
import { floorLabel, hasFloor, purposeLabel } from "./inventory";
import { propertyPrice } from "./price";
// Property documents (update 054). The server's limit is configurable and
// never above 25 MB; 20 MB is its default, checked here before uploading.
export const maxDocumentBytes = 20 * 1024 * 1024;
export const isPdf = (file) =>
  (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) &&
  file.size > 0 &&
  file.size <= maxDocumentBytes;
export function documentSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
// The file through the API (never a public link), as a Blob.
export const fetchDocument = (propertyId, doc) =>
  api(`/properties/${propertyId}/documents/${doc.id}/file`, {
    download: true,
  });
export const uploadDocument = (propertyId, file) => {
  const body = new FormData();
  body.append("file", file);
  return api(`/properties/${propertyId}/documents`, { method: "POST", body });
};
// Phones and tablets can hand a PDF to WhatsApp through the share sheet;
// desktop browsers cannot attach files to WhatsApp at all.
export function canShareFiles() {
  try {
    return (
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({
        files: [new File(["%PDF-"], "check.pdf", { type: "application/pdf" })],
      })
    );
  } catch {
    return false;
  }
}
// The message that goes with a shared document: details only, no link.
export function shareText(p) {
  return [
    p.title,
    [
      p.type,
      hasFloor(p.type) && floorLabel(p.floor_level),
      p.purpose && purposeLabel(p.purpose).toLowerCase(),
    ]
      .filter(Boolean)
      .join(", "),
    p.location,
    p.price != null && propertyPrice(p),
  ]
    .filter(Boolean)
    .join("\n");
}

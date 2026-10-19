import { CFB } from "xlsx";
const types = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const invalid = () =>
  Object.assign(
    new Error(
      "Choose a valid PDF, DOC or DOCX file up to 10 MB. Word files must be unencrypted.",
    ),
    { status: 400 },
  );

// Inspect a bounded DOCX directory without inflating untrusted ZIP contents.
// Uploaded Office/PDF content is downloaded, never rendered or executed here.
function checkDocx(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50)
    throw invalid();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6))
    throw invalid();
  const count = buffer.readUInt16LE(end + 10),
    directorySize = buffer.readUInt32LE(end + 12);
  let position = buffer.readUInt32LE(end + 16),
    total = 0;
  const start = position,
    names = new Set();
  if (!count || count > 512 || position + directorySize > end) throw invalid();
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50)
      throw invalid();
    const flags = buffer.readUInt16LE(position + 8),
      method = buffer.readUInt16LE(position + 10);
    const packed = buffer.readUInt32LE(position + 20),
      size = buffer.readUInt32LE(position + 24);
    const length = buffer.readUInt16LE(position + 28),
      extra = buffer.readUInt16LE(position + 30),
      comment = buffer.readUInt16LE(position + 32);
    const next = position + 46 + length + extra + comment;
    if (
      next > start + directorySize ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > 25 * 1024 * 1024 ||
      size > Math.max(1024 * 1024, packed * 100)
    )
      throw invalid();
    total += size;
    const name = buffer
      .subarray(position + 46, position + 46 + length)
      .toString("utf8");
    const local = buffer.readUInt32LE(position + 42);
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50)
      throw invalid();
    const localLength = buffer.readUInt16LE(local + 26),
      localExtra = buffer.readUInt16LE(local + 28);
    if (
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method ||
      local + 30 + localLength + localExtra + packed > start ||
      buffer.subarray(local + 30, local + 30 + localLength).toString("utf8") !==
        name ||
      (!(flags & 8) &&
        (buffer.readUInt32LE(local + 18) !== packed ||
          buffer.readUInt32LE(local + 22) !== size))
    )
      throw invalid();
    if (
      total > 50 * 1024 * 1024 ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      /vbaProject\.bin$/i.test(name) ||
      names.has(name)
    )
      throw invalid();
    names.add(name);
    position = next;
  }
  if (
    position !== start + directorySize ||
    !names.has("[Content_Types].xml") ||
    !names.has("word/document.xml")
  )
    throw invalid();
}
export function validateDocumentFile(file) {
  try {
    const buffer = file?.buffer,
      extension = file?.originalname?.split(".").at(-1).toLowerCase();
    if (
      !buffer?.length ||
      buffer.length > 10 * 1024 * 1024 ||
      !types[extension]
    )
      throw invalid();
    if (
      ![
        types[extension],
        "application/octet-stream",
        ...(extension === "docx" ? ["application/zip"] : []),
      ].includes(file.mimetype)
    )
      throw invalid();
    if (extension === "pdf") {
      if (
        buffer.subarray(0, 5).toString() !== "%PDF-" ||
        !buffer.subarray(-1024).includes(Buffer.from("%%EOF"))
      )
        throw invalid();
    } else if (extension === "doc") {
      if (
        !buffer
          .subarray(0, 8)
          .equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))
      )
        throw invalid();
      const word = CFB.find(
        CFB.read(buffer, { type: "buffer" }),
        "WordDocument",
      );
      if (!word || word.content?.[0] !== 0xec || word.content?.[1] !== 0xa5)
        throw invalid();
    } else checkDocx(buffer);
    const basename = file.originalname
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .normalize("NFKC")
      .replace(/\p{C}/gu, "");
    const stem =
      basename.slice(0, -(extension.length + 1)).slice(0, 180) || "document";
    return {
      file_name: stem + "." + extension,
      mime_type: types[extension],
      size_bytes: buffer.length,
    };
  } catch {
    throw invalid();
  }
}

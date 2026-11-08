import { useId, useRef, useState } from "react";
import { FilePlus2 } from "lucide-react";
import { Button, ErrorBox } from "../common/UI";
import {
  documentSize,
  isPdf,
  maxDocumentBytes,
} from "../../lib/propertyDocuments";
import "../../styles/properties.css";
// Update 054: PDFs chosen in the property form, uploaded when it is saved,
// like its pictures.
export default function PropertyDocumentPicker({
  documents,
  onChange,
  disabled,
  existing,
}) {
  const input = useRef();
  const headingId = useId(),
    helpId = useId();
  const [error, setError] = useState("");
  function choose(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (disabled) return;
    const valid = files.filter(isPdf);
    setError(
      valid.length !== files.length
        ? `Some files were skipped. Choose PDF files up to ${maxDocumentBytes / 1048576} MB each.`
        : "",
    );
    onChange((current) => [
      ...current,
      ...valid
        .filter(
          (file) =>
            !current.some(
              (d) =>
                d.file.name === file.name &&
                d.file.size === file.size &&
                d.file.lastModified === file.lastModified,
            ),
        )
        .map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  }
  return (
    <section className="property-photo-picker" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Property documents <span>(optional)</span>
      </h3>
      <p id={helpId}>
        Brochures, floor plans, payment plans or specifications: PDF files up to{" "}
        {maxDocumentBytes / 1048576} MB each. They upload when you save the
        property.
        {existing &&
          " Documents already added are listed in the property's details."}
      </p>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => input.current.click()}
      >
        <FilePlus2 size={18} aria-hidden="true" /> Add PDF documents
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="application/pdf,.pdf"
        aria-label="Property documents"
        aria-describedby={helpId}
        disabled={disabled}
        onChange={choose}
      />
      <ErrorBox error={error} />
      {!!documents.length && (
        <ul className="document-list" aria-label="Documents ready to upload">
          {documents.map((d) => (
            <li key={d.id}>
              <span className="document-name">
                <b>{d.file.name}</b>
                <small>{documentSize(d.file.size)} · ready to upload</small>
              </span>
              <span className="document-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled}
                  aria-label={`Remove ${d.file.name}`}
                  onClick={() =>
                    onChange((current) => current.filter((x) => x.id !== d.id))
                  }
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

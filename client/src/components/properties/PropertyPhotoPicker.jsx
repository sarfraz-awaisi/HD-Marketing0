import { useEffect, useId, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { Button, ErrorBox } from "../common/UI";

function SelectedPicture({ picture, disabled, onRemove }) {
  const [preview, setPreview] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(picture.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [picture.file]);
  return (
    <figure>
      {preview && (
        <img
          src={preview}
          alt={`Selected property picture: ${picture.file.name}`}
        />
      )}
      <figcaption>{picture.file.name}</figcaption>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        aria-label={`Remove ${picture.file.name}`}
        onClick={onRemove}
      >
        Remove picture
      </Button>
    </figure>
  );
}

export default function PropertyPhotoPicker({ pictures, onChange, disabled }) {
  const input = useRef();
  const headingId = useId(),
    helpId = useId();
  const [error, setError] = useState("");
  function choosePictures(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (disabled) return;
    const valid = files.filter(
      (file) =>
        ["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
        file.size > 0 &&
        file.size <= 5 * 1024 * 1024,
    );
    setError(
      valid.length !== files.length
        ? "Some files were skipped. Choose JPG, PNG or WebP pictures, up to 5 MB each."
        : "",
    );
    onChange((current) => {
      const next = [...current];
      for (const file of valid) {
        if (
          !next.some(
            (p) =>
              p.file.name === file.name &&
              p.file.size === file.size &&
              p.file.lastModified === file.lastModified,
          )
        )
          next.push({ id: crypto.randomUUID(), file });
      }
      return next;
    });
  }
  return (
    <section className="property-photo-picker" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Property pictures <span>(optional)</span>
      </h3>
      <p id={helpId}>
        Choose one or more JPG, PNG or WebP pictures, up to 5 MB each. Pictures
        upload when you save the property.
      </p>
      <Button
        type="button"
        variant="secondary"
        disabled={disabled}
        onClick={() => input.current.click()}
      >
        <ImagePlus size={18} aria-hidden="true" /> Add pictures
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/jpeg,image/png,image/webp"
        aria-label="Property pictures"
        aria-describedby={helpId}
        disabled={disabled}
        onChange={choosePictures}
      />
      <ErrorBox error={error} />
      {!!pictures.length && (
        <>
          <p role="status">
            {pictures.length} {pictures.length === 1 ? "picture" : "pictures"}{" "}
            ready to upload
          </p>
          <div className="photo-gallery selected-property-pictures">
            {pictures.map((picture) => (
              <SelectedPicture
                key={picture.id}
                picture={picture}
                disabled={disabled}
                onRemove={() =>
                  onChange((current) =>
                    current.filter((p) => p.id !== picture.id),
                  )
                }
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

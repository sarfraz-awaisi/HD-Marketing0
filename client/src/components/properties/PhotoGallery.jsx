import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { usePropertyPhotos } from "../../lib/usePropertyPhotos";
import { Button, ErrorBox } from "../common/UI";
export default function PhotoGallery({ propertyId, admin = false }) {
  const qc = useQueryClient(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const q = usePropertyPhotos(propertyId);
  return (
    <>
      <ErrorBox error={q.error || error} />
      <div className="photo-gallery">
        {q.data?.map((p) => (
          <figure key={p.id}>
            <img src={p.url} alt="Property photograph" />
            {admin && (
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!window.confirm("Delete this photo permanently?")) return;
                  try {
                    await api("/properties/" + propertyId + "/photos/" + p.id, {
                      method: "DELETE",
                    });
                    qc.invalidateQueries({ queryKey: ["photos", propertyId] });
                    qc.invalidateQueries({ queryKey: ["properties"] });
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Delete photo
              </Button>
            )}
          </figure>
        ))}
      </div>
      {!q.data?.length && (
        <div className="property-placeholder">
          ⌂<small>No photos added</small>
        </div>
      )}
      {admin && (
        <label className="button secondary">
          {busy ? "Uploading…" : "Upload photo (max 5 MB)"}
          <input
            aria-label="Upload property photo"
            hidden
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files[0];
              if (!file) return;
              setError("");
              if (file.size > 5 * 1024 * 1024) {
                setError("Maximum upload size is 5 MB");
                return;
              }
              setBusy(true);
              try {
                const body = new FormData();
                body.append("file", file);
                await api("/properties/" + propertyId + "/photos", {
                  method: "POST",
                  body,
                });
                qc.invalidateQueries({ queryKey: ["photos", propertyId] });
                qc.invalidateQueries({ queryKey: ["properties"] });
              } catch (e) {
                setError(e.message);
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
        </label>
      )}
    </>
  );
}

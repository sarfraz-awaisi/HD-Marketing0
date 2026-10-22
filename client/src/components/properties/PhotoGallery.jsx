import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { usePropertyPhotos } from "../../lib/usePropertyPhotos";
import { Button, ErrorBox } from "../common/UI";
// canManage: the viewer may change this property's pictures (administrators
// for company inventory, the owning agent for their own). The server checks.
export default function PhotoGallery({ propertyId, canManage = false }) {
  const qc = useQueryClient(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const q = usePropertyPhotos(propertyId);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["photos", propertyId] });
    qc.invalidateQueries({ queryKey: ["properties"] });
  };
  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ErrorBox error={q.error || error} />
      <div className="photo-gallery">
        {q.data?.map((p, index) => (
          <figure key={p.id}>
            <img src={p.url} alt="Property photograph" />
            {index === 0 && q.data.length > 1 && (
              <figcaption>Cover picture</figcaption>
            )}
            {canManage && (
              <div className="photo-actions">
                {index > 0 && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api(`/properties/${propertyId}/photos/order`, {
                          method: "PUT",
                          body: {
                            photo_ids: [
                              p.id,
                              ...q.data
                                .filter((x) => x.id !== p.id)
                                .map((x) => x.id),
                            ],
                          },
                        }),
                      )
                    }
                  >
                    Make cover
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm("Delete this photo permanently?"))
                      return;
                    run(() =>
                      api("/properties/" + propertyId + "/photos/" + p.id, {
                        method: "DELETE",
                      }),
                    );
                  }}
                >
                  Delete photo
                </Button>
              </div>
            )}
          </figure>
        ))}
      </div>
      {!q.data?.length && (
        <div className="property-placeholder">
          ⌂<small>No photos added</small>
        </div>
      )}
      {canManage && (
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
              const body = new FormData();
              body.append("file", file);
              await run(() =>
                api("/properties/" + propertyId + "/photos", {
                  method: "POST",
                  body,
                }),
              );
              e.target.value = "";
            }}
          />
        </label>
      )}
    </>
  );
}

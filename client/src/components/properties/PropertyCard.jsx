import { useRef, useState } from "react";
import { Building2, Images } from "lucide-react";
import { pkr } from "../../lib/api";
import {
  propertyRef,
  purposeLabel,
  sizeLabel,
  statusLabel,
} from "../../lib/inventory";
import { usePropertyPhotos } from "../../lib/usePropertyPhotos";
import { Button } from "../common/UI";
export default function PropertyCard({ property, onView }) {
  const batched = Object.hasOwn(property, "cover_photo");
  const photos = usePropertyPhotos(property.id, {
    refresh: false,
    enabled: !batched,
  });
  const [failedUrl, setFailedUrl] = useState(null);
  const retried = useRef(false);
  // The cover is deliberately kept separate from the complete gallery cache.
  const cover =
    photos.data !== undefined ? photos.data[0] : property.cover_photo;
  const photoCount = photos.data?.length ?? property.photo_count ?? 0;
  const hasPicture = !!cover?.url && cover.url !== failedUrl;
  return (
    <article className="property-card fx-card">
      <button
        type="button"
        className="property-illustration"
        aria-label={`Open ${property.title} details`}
        onClick={onView}
      >
        {hasPicture ? (
          <img
            src={cover.url}
            alt={`${property.title} — property photograph`}
            loading="lazy"
            decoding="async"
            onLoad={() => {
              retried.current = false;
            }}
            onError={() => {
              setFailedUrl(cover.url);
              // Renew an expired lazy-loaded URL once. Loaded card pictures do
              // not need polling; the open gallery refreshes the shared cache.
              if (!retried.current) {
                retried.current = true;
                void photos.refetch();
              }
            }}
          />
        ) : (
          <span className="property-cover-placeholder">
            <Building2 size={44} aria-hidden="true" />
            <small>
              {!batched && photos.isPending
                ? "Loading picture…"
                : photos.error || cover?.id
                  ? "Picture unavailable"
                  : "No pictures added"}
            </small>
          </span>
        )}
        <span className={`badge fx-badge ${property.availability}`}>
          {statusLabel(property.availability)}
        </span>
        <small>{property.type}</small>
        {hasPicture && photoCount > 1 && (
          <span className="property-photo-count">
            <Images size={14} aria-hidden="true" />
            {photoCount} photos
          </span>
        )}
      </button>
      <div className="property-card-body">
        <small>{property.location}</small>
        <h2>{property.title}</h2>
        <strong>
          {pkr(property.price)}
          {property.purpose === "rent" && <small> / month</small>}
        </strong>
        <p>
          {sizeLabel(property)} · {property.type}
          {property.purpose && <> · {purposeLabel(property.purpose)}</>}
        </p>
        {property.property_no && (
          <p className="property-ref">{propertyRef(property.property_no)}</p>
        )}
        {/* Update 044: promoted copies name the original listing agent. */}
        {property.promoted_from && (
          <p className="property-origin">
            Originally listed by {property.promoted_from.agent_name}
            {property.promoted_from.agent_uid != null &&
              ` · UID ${property.promoted_from.agent_uid}`}
          </p>
        )}
        {property.admin_copy && (
          <span className="badge info property-promoted">In Admin List</span>
        )}
        <Button variant="secondary" onClick={onView}>
          View property ↗
        </Button>
      </div>
    </article>
  );
}

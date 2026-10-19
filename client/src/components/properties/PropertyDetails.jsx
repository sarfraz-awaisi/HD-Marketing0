import { pkr } from "../../lib/api";
import { Badge } from "../common/UI";

export default function PropertyDetails({ property }) {
  return (
    <section className="property-details" aria-label="Property details">
      <div className="property-detail-summary">
        <strong>{pkr(property.price)}</strong>
        <Badge value={property.availability} />
      </div>
      <dl className="property-specs">
        <div>
          <dt>Location</dt>
          <dd>{property.location}</dd>
        </div>
        <div>
          <dt>Property type</dt>
          <dd>{property.type}</dd>
        </div>
        <div>
          <dt>Area</dt>
          <dd>
            {property.area} {property.area_unit}
          </dd>
        </div>
      </dl>
      <h3>Description</h3>
      <p className="property-description">
        {property.description || "No description added."}
      </p>
    </section>
  );
}

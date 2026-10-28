import { date, pkr } from "../../lib/api";
import { PromotedFrom } from "../inventory/PromotionPanel";
import {
  amenityLabel,
  constructionLabel,
  furnishingLabel,
  isPlot,
  propertyRef,
  purposeLabel,
  sizeLabel,
  statusLabel,
} from "../../lib/inventory";

const Spec = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
export default function PropertyDetails({ property: p }) {
  const contact = p.owner_contact;
  const building = !isPlot(p.type) && [
    ["Bedrooms", p.bedrooms],
    ["Bathrooms", p.bathrooms],
    ["Kitchens", p.kitchens],
    ["Floors", p.floors],
    ["Parking spaces", p.parking_spaces],
    ["Property age", p.property_age != null ? `${p.property_age} years` : null],
    ["Furnishing", p.furnishing && furnishingLabel(p.furnishing)],
    [
      "Construction",
      p.construction_status && constructionLabel(p.construction_status),
    ],
  ];
  return (
    <section className="property-details" aria-label="Property details">
      <div className="property-detail-summary">
        <strong>
          {pkr(p.price)}
          {p.purpose === "rent" && <small> / month</small>}
        </strong>
        <span className={`badge ${p.availability}`}>
          {statusLabel(p.availability)}
        </span>
      </div>
      {(p.price_negotiable || p.price_notes) && (
        <p className="field-hint">
          {[p.price_negotiable && "Negotiable", p.price_notes]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {p.promoted_from && (
        <PromotedFrom promoted={p.promoted_from} dateText={date} />
      )}
      <dl className="property-specs">
        <Spec label="Reference" value={propertyRef(p.property_no)} />
        <Spec label="Purpose" value={p.purpose && purposeLabel(p.purpose)} />
        <Spec label="Location" value={p.location} />
        <Spec label="Property type" value={p.type} />
        <Spec label="Area" value={sizeLabel(p)} />
        <Spec label="Province" value={p.province} />
        <Spec label="Street" value={p.street} />
        <Spec label="Plot / house number" value={p.plot_number} />
        <Spec label="Full address" value={p.address} />
        {building?.map(([label, value]) => (
          <Spec key={label} label={label} value={value} />
        ))}
      </dl>
      {p.map_url && (
        <p>
          <a href={p.map_url} target="_blank" rel="noopener noreferrer">
            Open map location ↗
          </a>
        </p>
      )}
      {!!p.amenities?.length && (
        <>
          <h3>Utilities and features</h3>
          <ul className="amenity-list">
            {p.amenities.map((a) => (
              <li key={a}>{amenityLabel(a)}</li>
            ))}
          </ul>
        </>
      )}
      <h3>Description</h3>
      <p className="property-description">
        {p.description || "No description added."}
      </p>
      {contact && (
        <>
          <h3>Owner contact</h3>
          <dl className="property-specs">
            <Spec label="Owner name" value={contact.owner_name} />
            <Spec
              label="Owner phone"
              value={
                contact.owner_phone && (
                  <a href={`tel:${contact.owner_phone}`}>
                    {contact.owner_phone}
                  </a>
                )
              }
            />
            <Spec
              label="Alternate phone"
              value={
                contact.owner_alt_phone && (
                  <a href={`tel:${contact.owner_alt_phone}`}>
                    {contact.owner_alt_phone}
                  </a>
                )
              }
            />
            <Spec label="Owner notes" value={contact.owner_notes} />
          </dl>
          {p.ownership === "company" && (
            <p className="field-hint">
              {contact.share_with_agents
                ? "Name and phone numbers are shared with agents."
                : "Not shared with agents."}
            </p>
          )}
        </>
      )}
      {(p.created_at || p.owner_agent_name) && (
        <dl className="property-specs property-meta">
          <Spec
            label="Inventory"
            value={
              p.ownership === "agent"
                ? `${p.owner_agent_name || "Agent"}'s inventory`
                : p.ownership && "Company inventory"
            }
          />
          <Spec
            label="Added"
            value={
              p.created_at &&
              [date(p.created_at), p.created_by_name]
                .filter(Boolean)
                .join(" · ")
            }
          />
          <Spec
            label="Last updated"
            value={
              p.updated_at &&
              [date(p.updated_at), p.updated_by_name]
                .filter(Boolean)
                .join(" · ")
            }
          />
        </dl>
      )}
    </section>
  );
}

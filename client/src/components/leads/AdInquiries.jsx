import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import "../../styles/leads.css";
// What the customer submitted through an advertisement's Google Sheet
// (update 056): interest, budget, advertisement, campaign, platform and
// date. A repeat inquiry is a later submission from a customer the CRM
// already had. Nothing shows for other leads.
const platforms = {
  facebook: "Facebook",
  instagram: "Instagram",
  messenger: "Messenger",
  audience_network: "Audience Network",
  other: "Other",
};
// Meta writes multiple-choice answers like 50_lakh_to_1_crore.
const answer = (value) => value?.replaceAll("_", " ");
// The inquiry's details, in order; optional ones only when given. The name
// and email submitted show only when they differ from the lead's.
const fields = (item, lead) =>
  [
    ["Property interest", answer(item.interest) || "—"],
    ["Preferred budget", answer(item.budget) || "—"],
    ["City", item.city],
    ["Advertisement", item.ad_name || "—"],
    ["Campaign", item.campaign_name || "—"],
    ["Form", item.form_name],
    [
      "Submitted as",
      item.full_name !== lead.name || (item.email && item.email !== lead.email)
        ? [item.full_name, item.email].filter(Boolean).join(" · ")
        : null,
    ],
    ...Object.entries(item.extra || {}).map(([question, value]) => [
      answer(question.replace(/[?_]+$/, "")),
      answer(value),
    ]),
  ].filter(([, value]) => value);
export default function AdInquiries({ lead }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["lead-inquiries", user.id, lead.id],
    queryFn: ({ signal }) => api(`/leads/${lead.id}/inquiries`, { signal }),
  });
  if (!q.data?.length) return null;
  return (
    <section className="panel ad-inquiries">
      <h2>Advertisement {q.data.length > 1 ? "inquiries" : "inquiry"}</h2>
      {q.data.map((item, i) => (
        <article key={i} className="ad-inquiry">
          <p className="ad-inquiry-heading">
            <b>{date(item.submitted_at || item.imported_at)}</b>
            {item.platform && (
              <span>
                {platforms[item.platform]}
                {item.is_organic ? " · organic" : ""}
              </span>
            )}
            {item.repeat && (
              <span className="ad-inquiry-repeat">Repeat inquiry</span>
            )}
          </p>
          <dl className="ad-inquiry-fields">
            {fields(item, lead).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <small>From the Sheet {item.source}</small>
        </article>
      ))}
    </section>
  );
}

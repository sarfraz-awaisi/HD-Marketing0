import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { addDays, dayLabel, fullDayLabel } from "../../lib/calendar";
import {
  dayStates,
  evidenceStates,
  platformLabels,
  weekStates,
} from "../../lib/kpiPeriods";
import { Button, ErrorBox, Loader, Modal } from "../common/UI";
// KPIs the CRM fills in (update 072), on the agent's My KPIs: what the CRM
// counted, and the evidence behind it with each item's review. Agents add
// links and visit photos here; administrators approve or reject them under
// Daily KPIs → Reviews. Nothing pending or rejected counts.
const PHOTO_MAX = 5 * 1024 * 1024;

// A link to a submitted post or video, opened in a new tab that gets no
// access to the CRM (noopener) and no address of the CRM page (noreferrer).
export function EvidenceLink({ url }) {
  let label = url;
  try {
    const u = new URL(url);
    // A YouTube link is told apart by its video (?v=).
    label =
      (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "") +
      (u.searchParams.get("v") ? `?v=${u.searchParams.get("v")}` : "");
  } catch {
    // Shown as it is.
  }
  if (!/^https:\/\//i.test(url || "")) return <span>{url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="kpi-evidence-url"
    >
      {label.length > 64 ? label.slice(0, 63) + "…" : label}
    </a>
  );
}
export function EvidenceStatus({ status }) {
  return (
    <span className={`kpi-evidence-status ${status}`}>
      {evidenceStates[status] ?? status}
    </span>
  );
}
// A visit photo through a short-lived signed link, for its agent or an
// administrator only.
export function PhotoViewer({ evidence, onClose }) {
  const q = useQuery({
    queryKey: ["kpis", "photo", evidence.id],
    queryFn: ({ signal }) =>
      api(`/kpis/evidence/${evidence.id}/photo`, { signal }),
    staleTime: 30000,
    gcTime: 30000,
  });
  return (
    <Modal
      title={`${evidence.project} · visit on ${fullDayLabel(evidence.day)}`}
      onClose={onClose}
      className="kpi-photo-modal"
    >
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        q.data?.url && (
          <img
            src={q.data.url}
            alt={`Visit photo: ${evidence.project}, ${fullDayLabel(evidence.day)}`}
          />
        )
      )}
    </Modal>
  );
}
// The agent's evidence, newest first, with each review.
function EvidenceList({ list, onPhoto }) {
  if (!list.length) return null;
  return (
    <ul className="kpi-evidence-list">
      {list.map((e) => (
        <li key={e.id}>
          <div className="kpi-evidence-main">
            {e.kind === "visit" ? (
              <button
                type="button"
                className="link-button"
                onClick={() => onPhoto(e)}
              >
                {e.project}: view photo
              </button>
            ) : (
              <EvidenceLink url={e.url} />
            )}
            <small>
              {e.kind === "visit"
                ? `Visit on ${dayLabel(e.day)}`
                : platformLabels[e.platform]}{" "}
              · added {date(e.submitted_at)}
            </small>
          </div>
          <EvidenceStatus status={e.status} />
          {e.status !== "pending" && (
            <small className="kpi-evidence-review">
              {evidenceStates[e.status]}
              {e.reviewed_at ? ` ${date(e.reviewed_at)}` : ""}
              {e.reason ? `. Reason: ${e.reason}` : ""}
            </small>
          )}
        </li>
      ))}
    </ul>
  );
}
function LinkAdder({ kind, label, hint, onAdded }) {
  const [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function add() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/kpis/evidence", {
        method: "POST",
        body: { kind, url: url.trim() },
      });
      setUrl("");
      onAdded(`Link added; it counts once an administrator approves it.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Not a form of its own: the KPI page is one form already.
  return (
    <div className="kpi-evidence-add" role="group" aria-label={label}>
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        placeholder="https://www.facebook.com/…"
        aria-label={label}
        maxLength={600}
        value={url}
        disabled={busy}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <Button type="button" onClick={add} disabled={busy || !url.trim()}>
        {busy ? "Adding…" : label}
      </Button>
      {hint && <small className="field-hint">{hint}</small>}
      {error && (
        <small className="kpi-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
function PhotoAdder({ days, onAdded }) {
  const [project, setProject] = useState(""),
    [day, setDay] = useState(days.at(-1)),
    [file, setFile] = useState(null),
    [reset, setReset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ready = file && project.trim().length >= 2;
  async function add() {
    if (busy || !ready) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      return setError("Choose a JPEG, PNG or WebP photo.");
    if (file.size > PHOTO_MAX) return setError("Choose a photo up to 5 MB.");
    const body = new FormData();
    body.append("project", project.trim());
    body.append("visit_date", day);
    body.append("file", file);
    setBusy(true);
    setError("");
    try {
      await api("/kpis/evidence/photo", { method: "POST", body });
      setProject("");
      setFile(null);
      setReset((n) => n + 1);
      onAdded(
        "Photo uploaded; the visit counts once an administrator approves it.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="kpi-evidence-add kpi-photo-add"
      role="group"
      aria-label="Upload a visit photo"
    >
      <label>
        Project
        <input
          maxLength={120}
          autoComplete="off"
          placeholder="e.g. DHA Phase 6"
          value={project}
          disabled={busy}
          onChange={(e) => setProject(e.target.value)}
        />
      </label>
      <label>
        Visit date
        <select
          value={day}
          disabled={busy}
          onChange={(e) => setDay(e.target.value)}
        >
          {days.map((d) => (
            <option key={d} value={d}>
              {dayLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Photo
        <input
          key={reset}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <Button type="button" onClick={add} disabled={busy || !ready}>
        {busy ? "Uploading…" : "Upload photo"}
      </Button>
      <small className="field-hint">
        One photo for each visit: JPEG, PNG or WebP up to 5 MB. Only you and
        administrators can see it.
      </small>
      {error && (
        <small className="kpi-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
function Counts({ rows }) {
  return (
    <dl className="kpi-counts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? 0}</dd>
        </div>
      ))}
    </dl>
  );
}
const tone = (item) =>
  item.frequency === "week"
    ? item.week?.status === "met"
      ? "met"
      : item.week?.status === "missed"
        ? "below"
        : ""
    : item.met === true
      ? "met"
      : item.met === false || item.state === "missed"
        ? "below"
        : "";
// One KPI the CRM fills in: its result, the numbers behind it, and for
// evidence KPIs the list and the way to add more.
export function MeasuredKpi({ item, data, onChanged }) {
  const [photo, setPhoto] = useState(null);
  const d = item.detail || {};
  const w = item.week;
  const wd = w?.detail || {};
  const evidence = data.evidence || [];
  const currentWeek = data.day >= data.editable_from;
  const weekText = w
    ? `This week: ${w.total}/${w.target}${w.status === "met" ? " · met" : ` · ${weekStates[w.status] ?? w.status}`}`
    : "";
  let summary, body;
  switch (item.measure) {
    case "calls":
      summary =
        item.state === "not_due"
          ? "No assigned calls due"
          : item.state === "pending"
            ? `In progress: ${d.on_time ?? 0} of ${d.due} called, deadlines still ahead`
            : item.answer
              ? "Yes: every assigned call made by its deadline"
              : item.answer === false
                ? `No: ${d.due - (d.on_time ?? 0)} of ${d.due} not called by the deadline`
                : (dayStates[item.state] ?? "—");
      body =
        item.state === "not_due" ? (
          <small className="field-hint">
            No lead's first-call deadline fell on this day, so nothing was due.
          </small>
        ) : (
          <Counts
            rows={[
              ["Assigned workload", d.due],
              ["Called by the deadline", d.on_time],
              ["Called late", d.late],
              ["Remaining", d.not_called],
              ["Calls made", d.attempts],
              ["Answered (connected)", d.answered],
            ]}
          />
        );
      break;
    case "social": {
      const list = evidence.filter(
        (e) => e.kind === "social" && e.day === data.day,
      );
      summary = item.answer
        ? "Yes: a link was approved"
        : item.state === "review"
          ? "Waiting for an administrator's review"
          : item.answer === false
            ? "No: no link was approved"
            : item.state === "pending"
              ? "Add at least one link today"
              : (dayStates[item.state] ?? "—");
      body = (
        <>
          <Counts
            rows={[
              ["Submitted", d.submitted],
              ["Approved", d.approved],
              ["Waiting", d.pending],
              ["Rejected", d.rejected],
            ]}
          />
          {data.day === data.today &&
            ((d.submitted ?? list.length) < 5 ? (
              <LinkAdder
                kind="social"
                label="Add link"
                hint={`Facebook, Instagram, TikTok or YouTube; up to 5 a day (${d.submitted ?? list.length} added).`}
                onAdded={onChanged}
              />
            ) : (
              <small className="field-hint">
                You have added the 5 links for today.
              </small>
            ))}
          <EvidenceList list={list} onPhoto={setPhoto} />
        </>
      );
      break;
    }
    case "inventory": {
      const list = data.inventory || [];
      summary = `${item.answer ?? 0}/${item.target} verified${item.met ? " · met" : item.state === "review" ? " · waiting for verification" : item.state === "pending" ? "" : item.state === "missed" ? " · no listings added" : ""}`;
      body = (
        <>
          <Counts
            rows={[
              ["Uploaded", d.uploaded],
              ["Waiting for verification", d.pending],
              ["Verified", d.verified],
              ["Rejected", d.rejected],
            ]}
          />
          {list.length > 0 && (
            <ul className="kpi-evidence-list">
              {list.map((p) => (
                <li key={p.id}>
                  <div className="kpi-evidence-main">
                    <Link to={`/inventory?property=${p.id}`}>
                      #{p.property_no} {p.title}
                    </Link>
                    <small>
                      {[p.area, p.city].filter(Boolean).join(", ")}
                      {!p.owner_details &&
                        " · add the owner's name and phone to have it verified"}
                    </small>
                  </div>
                  <EvidenceStatus status={p.status} />
                  {p.reason && (
                    <small className="kpi-evidence-review">
                      Reason: {p.reason}
                    </small>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.day === data.today && (
            <Link
              className="button fx-btn secondary kpi-add-listing"
              to="/inventory"
            >
              Add a listing in Inventory
            </Link>
          )}
        </>
      );
      break;
    }
    case "visits": {
      const list = evidence.filter((e) => e.kind === "visit");
      const days = [];
      for (let x = data.editable_from; x <= data.today; x = addDays(x, 1))
        days.push(x);
      summary = weekText;
      body = (
        <>
          <Counts
            rows={[
              ["Visits counted", w?.total],
              ["Photos uploaded", wd.submitted],
              ["Waiting", wd.pending],
              ["Rejected", wd.rejected],
            ]}
          />
          {currentWeek && <PhotoAdder days={days} onAdded={onChanged} />}
          <EvidenceList list={list} onPhoto={setPhoto} />
        </>
      );
      break;
    }
    case "video": {
      const list = evidence.filter((e) => e.kind === "video");
      summary = weekText;
      body = (
        <>
          <Counts
            rows={[
              ["Submitted", wd.submitted],
              ["Approved", wd.approved],
              ["Waiting", wd.pending],
              ["Rejected", wd.rejected],
            ]}
          />
          {currentWeek && (
            <LinkAdder
              kind="video"
              label="Add video link"
              hint="The link to the finished video on the HD Marketing page."
              onAdded={onChanged}
            />
          )}
          <EvidenceList list={list} onPhoto={setPhoto} />
        </>
      );
      break;
    }
    default:
      summary = "—";
  }
  return (
    <div className="kpi-measured">
      <span className={`kpi-progress ${tone(item)}`}>{summary}</span>
      {body}
      {photo && <PhotoViewer evidence={photo} onClose={() => setPhoto(null)} />}
    </div>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Table,
  useToast,
} from "../../components/common/UI";
import "../../styles/integrations.css";
// Google Sheets lead import (update 056), administrators only. Each Sheet is
// one tab of a Meta Lead Ads spreadsheet and keeps one lead file; the Google
// Apps Script (integrations/google-sheets) sends the rows with the
// integration key. Imported leads are assigned as usual, never on their own.
const base = "/integrations/sheets";
const errors = {
  spreadsheet_unavailable:
    "The script cannot open this spreadsheet. Share it with the Google account that runs the script (Viewer is enough).",
  worksheet_missing:
    "The spreadsheet has no tab with this name. Correct the tab name.",
  headers_missing:
    "The first row needs the columns id, phone_number and full_name.",
  read_failed:
    "The Sheet could not be read. It is tried again on the next run.",
  rows_failed:
    "Some rows could not be saved. They are tried again on the next run.",
  too_many_rows:
    "The tab has more than 50,000 rows. Move older rows to another tab.",
  file_deleted:
    "This Sheet's lead file was deleted. Restore it from Deleted leads, or start a new lead file.",
};
export const rejectionReasons = {
  id_invalid: "Meta lead ID missing or not recognised",
  phone_invalid: "Phone number missing or invalid",
  name_missing: "Customer name missing",
  name_too_long: "Customer name longer than 200 characters",
  date_missing:
    "Submission date missing or unreadable (needed for the start date)",
  value_too_long: "A cell is longer than 5,000 characters",
  lead_deleted: "This number is in Deleted leads",
};
// The script checks every five minutes; twenty minutes of silence from a
// Sheet that is on means the script has stopped or cannot reach it.
const quiet = (source) =>
  source.enabled &&
  (!source.last_check_at ||
    Date.now() - new Date(source.last_check_at).getTime() > 20 * 60000);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sheetLink = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const day = (value) =>
  value
    ? new Date(new Date(value).getTime() + 5 * 3600000)
        .toISOString()
        .slice(0, 10)
    : "";

// draft: what was entered before the historical import was asked about.
function SourceForm({ source, draft, busy, onSave }) {
  const [form, setForm] = useState({
    name: draft?.name ?? source?.name ?? "",
    spreadsheet: draft?.spreadsheet ?? "",
    worksheet: draft?.worksheet ?? source?.worksheet ?? "Sheet1",
    import_from: draft ? draft.import_from || "" : day(source?.import_from),
    enabled: draft?.enabled ?? source?.enabled ?? false,
  });
  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    });
  return (
    <form
      className="form-grid sheet-form"
      onSubmit={(e) => {
        e.preventDefault();
        const { spreadsheet, ...rest } = form;
        onSave({
          ...rest,
          import_from: rest.import_from || null,
          ...(source ? {} : { spreadsheet }),
        });
      }}
    >
      <label>
        Name (also the lead file's name)
        <input
          required
          maxLength={200}
          value={form.name}
          onChange={set("name")}
          placeholder="DHA plots, November"
        />
      </label>
      {source ? (
        <p className="sheet-note">
          Spreadsheet{" "}
          <a
            href={sheetLink(source.spreadsheet_id)}
            target="_blank"
            rel="noreferrer"
          >
            {source.spreadsheet_id}
          </a>
          . It cannot change; add another spreadsheet as a new Sheet.
        </p>
      ) : (
        <label>
          Google Sheet link or ID
          <input
            required
            maxLength={500}
            value={form.spreadsheet}
            onChange={set("spreadsheet")}
            placeholder="https://docs.google.com/spreadsheets/d/…"
          />
        </label>
      )}
      <label>
        Tab name
        <input
          required
          maxLength={100}
          value={form.worksheet}
          onChange={set("worksheet")}
        />
      </label>
      <label>
        Import rows submitted from (optional)
        <input
          type="date"
          value={form.import_from}
          onChange={set("import_from")}
        />
        <small>Empty imports every row, including older ones.</small>
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={set("enabled")}
        />
        Import from this Sheet
      </label>
      <footer>
        <Button disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </footer>
    </form>
  );
}

function Rejections({ source, onClose }) {
  const q = useQuery({
    queryKey: ["google-sheets", "rejections", source.id],
    queryFn: ({ signal }) =>
      api(`${base}/sources/${source.id}/rejections`, { signal }),
  });
  return (
    <Modal title={`Rejected rows · ${source.name}`} onClose={onClose}>
      <p>
        Fix these rows in the Sheet: each run sends them again, and a fixed row
        is imported. A row deleted from the Sheet leaves this list after the
        next complete run.
      </p>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <Table
          // One rejection per row of the Sheet.
          rows={(q.data || []).map((r) => ({ ...r, id: r.row }))}
          empty="No rejected rows."
          columns={[
            { key: "row", label: "Row" },
            {
              key: "reason",
              label: "Reason",
              render: (r) =>
                rejectionReasons[r.reason] +
                (r.lead_no
                  ? ` (${r.lead_no}). Restore it to link this inquiry.`
                  : ""),
            },
            {
              key: "meta_lead_id",
              label: "Meta lead ID",
              render: (r) => r.meta_lead_id || "—",
            },
            {
              key: "last_seen_at",
              label: "Last checked",
              render: (r) => date(r.last_seen_at),
            },
          ]}
        />
      )}
    </Modal>
  );
}

// Decision 8: the first import of rows already in a Sheet is confirmed
// explicitly; the CRM records who confirmed it and for which start date.
function HistoryConfirmation({ modal, busy, error, onCancel, onConfirm }) {
  const name = modal.body.name || modal.source?.name;
  const from =
    "import_from" in modal.body
      ? modal.body.import_from
      : modal.source?.import_from;
  // A date from the form is the start of that day in Pakistan.
  const since =
    from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00+05:00` : from;
  return (
    <Modal
      title="Confirm the historical import"
      onClose={() => !busy && onCancel()}
    >
      <ErrorBox error={error} />
      <p>
        Turning on <b>{name}</b> imports{" "}
        {since
          ? `every row submitted since ${date(since)}`
          : "every row already in the Sheet"}
        , as well as new submissions. Each becomes a new lead in the Sheet's
        lead file, or a repeat inquiry when the number is already in the CRM.
      </p>
      <p>
        Imported leads stay unassigned until you assign them. Your confirmation
        is recorded.
      </p>
      <footer>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {busy ? "Turning on…" : "Confirm and turn on"}
        </Button>
      </footer>
    </Modal>
  );
}

export default function GoogleSheets() {
  const qc = useQueryClient(),
    toast = useToast();
  const [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [newKey, setNewKey] = useState(null);
  const q = useQuery({
    queryKey: ["google-sheets"],
    queryFn: ({ signal }) => api(base, { signal }),
    refetchInterval: 60000,
  });
  // refused(e): handles a refusal itself, returning true.
  async function run(fn, message, refused) {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await qc.invalidateQueries({ queryKey: ["google-sheets"] });
      invalidateWorkspace(qc);
      if (message)
        toast(typeof message === "function" ? message(result) : message);
      setModal(null);
      return result;
    } catch (e) {
      if (!refused?.(e)) setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Adds or changes a Sheet. Turning on a Sheet whose earlier rows would be
  // imported asks the administrator to confirm that historical import first;
  // the CRM refuses it otherwise.
  const saveSheet = (source, body, message, back) =>
    run(
      () =>
        source
          ? api(`${base}/sources/${source.id}`, { method: "PATCH", body })
          : api(`${base}/sources`, { method: "POST", body }),
      message,
      (e) =>
        e.code === "SHEETS_CONFIRM_HISTORY" &&
        (setModal({ kind: "history", source, body, message, back }), true),
    );
  const key = q.data?.key;
  const sources = q.data?.sources || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">INTEGRATIONS</span>
          <h1>Google Sheets</h1>
          <p>
            Leads from each advertisement's Meta Lead Ads Sheet arrive in their
            own lead file, checked every five minutes. Assign them to agents as
            usual; nothing is assigned automatically.
          </p>
        </div>
        <Button onClick={() => setModal({ kind: "add" })}>Add Sheet</Button>
      </div>
      <ErrorBox error={(!modal && error) || q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        q.data && (
          <>
            <section className="panel sheet-key">
              <div className="panel-heading">
                <h2>Integration key</h2>
                <div className="actions">
                  <Button
                    variant={key ? "secondary" : ""}
                    disabled={busy}
                    onClick={() =>
                      setModal({ kind: key ? "replace" : "create" })
                    }
                  >
                    {key ? "Replace key" : "Create key"}
                  </Button>
                  {key && (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => setModal({ kind: "revoke" })}
                    >
                      Turn off the key
                    </Button>
                  )}
                </div>
              </div>
              {key ? (
                <p>
                  Active key ending <code>…{key.hint}</code>, created by{" "}
                  {key.created_by} on {date(key.created_at)}. Last used{" "}
                  {date(key.last_used_at)}. Leads are created as{" "}
                  {key.created_by}.
                </p>
              ) : (
                <p>
                  No key: the Google Apps Script cannot send leads. Create one
                  when you are ready to turn the import on.
                </p>
              )}
              {key && !key.owner_active && (
                <ErrorBox error="The administrator who created this key is no longer an active administrator, so imports are refused. Replace the key." />
              )}
            </section>
            <section className="panel sheet-records">
              <h2>Sheets</h2>
              <Table
                rows={sources}
                empty="No Sheets yet. Add each advertisement's Sheet."
                columns={[
                  {
                    key: "name",
                    label: "Sheet",
                    render: (s) => (
                      <div className="sheet-name">
                        <b>{s.name}</b>
                        <small>
                          Tab {s.worksheet} ·{" "}
                          <a
                            href={sheetLink(s.spreadsheet_id)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open in Google Sheets
                          </a>
                        </small>
                        {s.import_from && (
                          <small>Rows from {date(s.import_from)}</small>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "file",
                    label: "Lead file",
                    render: (s) =>
                      !s.import_id ? (
                        <small>Created on the first import</small>
                      ) : s.file_deleted ? (
                        <span className="sheet-warning">Deleted</span>
                      ) : (
                        <Link
                          className="customer-link"
                          to={`/leads?import_id=${s.import_id}`}
                        >
                          {s.file_name}
                        </Link>
                      ),
                  },
                  {
                    key: "enabled",
                    label: "Status",
                    render: (s) => (
                      <div className="sheet-status">
                        <span
                          className={`sheet-state ${s.enabled ? "on" : "off"}`}
                        >
                          {s.enabled ? "On" : "Off"}
                        </span>
                        <small>Checked {date(s.last_check_at)}</small>
                        {s.history_confirmed_at && (
                          <small>
                            Historical import confirmed by{" "}
                            {s.history_confirmed_by} on{" "}
                            {date(s.history_confirmed_at)}
                          </small>
                        )}
                        {quiet(s) && (
                          <small className="sheet-warning">
                            {s.last_check_at
                              ? "No check from the script for 20 minutes"
                              : "Waiting for the script's first check"}
                          </small>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "new_leads",
                    label: "Imported",
                    render: (s) => (
                      <div className="sheet-counts">
                        <b>{plural(s.new_leads, "new lead", "new leads")}</b>
                        <small>
                          {plural(
                            s.repeat_inquiries,
                            "repeat inquiry",
                            "repeat inquiries",
                          )}
                        </small>
                        {s.unassigned > 0 && (
                          <small>{s.unassigned} waiting for an agent</small>
                        )}
                      </div>
                    ),
                  },
                  {
                    key: "last_sync_at",
                    label: "Last successful sync",
                    render: (s) => date(s.last_sync_at),
                  },
                  {
                    key: "rejected",
                    label: "Rejected rows",
                    render: (s) =>
                      s.rejected > 0 ? (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setModal({ kind: "rejections", source: s })
                          }
                        >
                          {s.rejected} · View
                        </Button>
                      ) : (
                        "0"
                      ),
                  },
                  {
                    key: "last_error_code",
                    label: "Latest error",
                    render: (s) =>
                      s.last_error_code ? (
                        <div className="sheet-error">
                          {errors[s.last_error_code] || "Unknown error"}
                          <small>{date(s.last_error_at)}</small>
                        </div>
                      ) : (
                        "—"
                      ),
                  },
                  {
                    key: "actions",
                    label: "Action",
                    render: (s) => (
                      <div className="lead-row-actions">
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setModal({ kind: "edit", source: s })}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            saveSheet(
                              s,
                              { enabled: !s.enabled },
                              s.enabled
                                ? `${s.name} turned off`
                                : `${s.name} turned on`,
                            )
                          }
                        >
                          {s.enabled ? "Turn off" : "Turn on"}
                        </Button>
                        {s.file_deleted && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              setModal({ kind: "new-file", source: s })
                            }
                          >
                            Start a new lead file
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </section>
            <section className="panel sheet-help">
              <h2>How the import runs</h2>
              <ol>
                <li>
                  Create the key, then in Google Apps Script add the CRM's
                  script and set its Script Properties:{" "}
                  <code>CRM_BASE_URL</code> ={" "}
                  <code>{window.location.origin}</code> and{" "}
                  <code>CRM_SHEETS_KEY</code> = the key.
                </li>
                <li>
                  Share each Sheet with the Google account that runs the script
                  (Viewer is enough), add it here and turn it on.
                </li>
                <li>
                  Run <code>checkSetup</code>, then <code>syncLeads</code> for
                  the first import, then <code>installTrigger</code> to check
                  every five minutes.
                </li>
              </ol>
              <p>
                Each run sends only rows the CRM has not imported, and sends
                rejected or failed rows again, so nothing needs retrying by
                hand. To import at once, run <code>syncLeads</code> in the Apps
                Script editor. A number that already belongs to a lead is kept
                as a repeat inquiry on that lead, which is not changed.
              </p>
            </section>
          </>
        )
      )}
      {(modal?.kind === "add" || modal?.kind === "edit") && (
        <Modal
          title={
            modal.kind === "add" ? "Add Sheet" : `Edit ${modal.source.name}`
          }
          onClose={() => !busy && setModal(null)}
        >
          <ErrorBox error={error} />
          <SourceForm
            source={modal.source}
            draft={modal.draft}
            busy={busy}
            onSave={(body) =>
              saveSheet(
                modal.source,
                body,
                modal.source ? "Sheet saved" : "Sheet added",
                modal.kind,
              )
            }
          />
        </Modal>
      )}
      {modal?.kind === "history" && (
        <HistoryConfirmation
          modal={modal}
          busy={busy}
          error={error}
          onCancel={() =>
            setModal(
              modal.back
                ? { kind: modal.back, source: modal.source, draft: modal.body }
                : null,
            )
          }
          onConfirm={() =>
            saveSheet(
              modal.source,
              { ...modal.body, confirm_history: true },
              modal.message,
            )
          }
        />
      )}
      {modal?.kind === "rejections" && (
        <Rejections source={modal.source} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "new-file" && (
        <Modal
          title="Start a new lead file"
          onClose={() => !busy && setModal(null)}
        >
          <ErrorBox error={error} />
          <p>
            The next import from {modal.source.name} starts a new lead file.
            Rows already imported are not imported again. To keep using the
            deleted file, restore it from Deleted leads instead.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api(`${base}/sources/${modal.source.id}/new-file`, {
                      method: "POST",
                      body: {},
                    }),
                  "The next import starts a new lead file",
                )
              }
            >
              Start a new lead file
            </Button>
          </footer>
        </Modal>
      )}
      {["create", "replace"].includes(modal?.kind) && (
        <Modal
          title={modal.kind === "create" ? "Create key" : "Replace key"}
          onClose={() => !busy && setModal(null)}
        >
          <ErrorBox error={error} />
          <p>
            {modal.kind === "replace"
              ? "The current key stops working at once; paste the new key into the Apps Script's Script Properties straight away. "
              : ""}
            Leads the script sends are created as you. The key is shown only
            once.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                const result = await run(() =>
                  api(`${base}/key`, { method: "POST", body: {} }),
                );
                if (result) setNewKey(result.key);
              }}
            >
              {modal.kind === "create" ? "Create key" : "Replace key"}
            </Button>
          </footer>
        </Modal>
      )}
      {modal?.kind === "revoke" && (
        <Modal title="Turn off the key" onClose={() => !busy && setModal(null)}>
          <ErrorBox error={error} />
          <p>
            The Apps Script stops sending leads at once. Imported leads and the
            Sheets' settings stay. Create a new key to turn the import on again.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(
                  () => api(`${base}/key`, { method: "DELETE" }),
                  "Key turned off",
                )
              }
            >
              Turn off the key
            </Button>
          </footer>
        </Modal>
      )}
      {newKey && (
        <Modal title="Your new integration key" onClose={() => setNewKey(null)}>
          <p>
            Copy it into the Apps Script's Script Properties as{" "}
            <code>CRM_SHEETS_KEY</code>. It is not shown again; if it is lost,
            replace the key.
          </p>
          <code className="sheet-new-key" aria-label="New integration key">
            {newKey}
          </code>
          <footer>
            <Button
              variant="secondary"
              onClick={() =>
                navigator.clipboard?.writeText(newKey).then(
                  () => toast("Key copied"),
                  () => toast("Copy it by hand"),
                )
              }
            >
              Copy key
            </Button>
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </footer>
        </Modal>
      )}
    </>
  );
}

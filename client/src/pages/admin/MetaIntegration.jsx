import { useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { metaApi, metaStatus } from "../../lib/meta";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  useToast,
} from "../../components/common/UI";
const targets = [
  "name",
  "first_name",
  "last_name",
  "phone",
  "email",
  "preferred_location",
  "budget_min",
  "budget_max",
  "interested_property",
  "property_type",
  "contact_time",
  "message",
];
function FormMapping({ form, busy, save }) {
  const [mapping, setMapping] = useState(form.mapping || {});
  const questions = [
    ...new Set([
      ...(form.questions || []).map((q) => q.key),
      ...Object.keys(mapping),
    ]),
  ].filter(Boolean);
  const [custom, setCustom] = useState("");
  return (
    <article className="panel meta-form">
      <h3>{form.name}</h3>
      <p>
        {form.enabled
          ? "Synchronizing selected Page submissions"
          : "Not synchronizing"}{" "}
        · Form {form.id}
      </p>
      <div className="form-grid">
        {questions.map((key) => (
          <label key={key}>
            {form.questions?.find((q) => q.key === key)?.label || key}
            <small>{key}</small>
            <select
              aria-label={`Map ${key}`}
              disabled={busy}
              value={mapping[key] || ""}
              onChange={(e) =>
                setMapping({ ...mapping, [key]: e.target.value })
              }
            >
              <option value="">Automatic match / keep answer</option>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="toolbar">
        <label>
          Additional question key
          <input
            value={custom}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <Button
          variant="secondary"
          disabled={busy || !custom.trim()}
          onClick={() => {
            setMapping({ ...mapping, [custom.trim()]: "" });
            setCustom("");
          }}
        >
          Add mapping
        </Button>
      </div>
      <div className="meta-actions">
        <Button
          disabled={busy}
          onClick={() => save(form, { enabled: form.enabled, mapping })}
        >
          Save mapping
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => save(form, { enabled: !form.enabled, mapping })}
        >
          {form.enabled ? "Pause form" : "Enable form"}
        </Button>
        {form.enabled && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => save(form, null)}
          >
            Check missed submissions
          </Button>
        )}
      </div>
    </article>
  );
}
export default function MetaIntegration() {
  const [params] = useSearchParams(),
    qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["meta-settings"],
    queryFn: () => api(metaApi + "/settings"),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [disconnect, setDisconnect] = useState(null),
    pending = useRef(false);
  async function run(action, message) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await action();
      await qc.invalidateQueries({ queryKey: ["meta-settings"] });
      await qc.invalidateQueries({ queryKey: ["meta-summary"] });
      if (message)
        toast(typeof message === "function" ? message(result) : message);
      return result;
    } catch (e) {
      setError(e.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading meta-page-heading">
        <div>
          <span className="eyebrow">CONNECTED MARKETING</span>
          <h1>Meta Lead Ads</h1>
          <p>
            Capture Instant Form enquiries. Every new customer waits for your
            assignment.
          </p>
        </div>
        <Link className="button secondary" to="/incoming-social">
          Incoming social leads
        </Link>
      </div>
      <ErrorBox error={error || q.error} />
      {params.get("connection") === "failed" && (
        <ErrorBox error="Meta authorization did not finish. Check approved permissions and Page access, then reconnect." />
      )}
      {params.get("connection") === "saved" && (
        <p role="status">
          Authorization saved. Select Pages and forms below to begin
          synchronization.
        </p>
      )}
      {q.isPending ? (
        <Loader />
      ) : (
        q.data && (
          <>
            <section className="panel">
              <h2>
                {q.data.connections?.some((c) => c.status !== "disconnected")
                  ? "Your Meta connections"
                  : "Not connected"}
              </h2>
              <p>
                {q.data.configured
                  ? "Connect a Meta business account with access to your advertising Pages."
                  : "Your administrator must configure Meta before connecting. The rest of your CRM remains available."}
              </p>
              <Button
                disabled={busy || !q.data.configured}
                onClick={() =>
                  run(async () => {
                    const result = await api(metaApi + "/connect", {
                      method: "POST",
                      body: {},
                    });
                    window.location.assign(result.url);
                  })
                }
              >
                {busy ? "Working…" : "Connect / reconnect Meta"}
              </Button>
              <p>
                Facebook and Instagram Instant Forms are supported. Website
                forms require a separate connection.
              </p>
            </section>
            {q.data.connections?.map((c) => (
              <section className="panel" key={c.id}>
                <div className="panel-heading">
                  <h2>{metaStatus(c.status)}</h2>
                  {c.status !== "disconnected" && (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => setDisconnect(c)}
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
                <p>Authorized account {c.provider_user_id}</p>
                <p>
                  Last received {date(c.last_success_at)} · Authorization
                  expires {date(c.expires_at)}
                </p>
                {c.error_code && (
                  <ErrorBox error={c.error_code.replaceAll("_", " ")} />
                )}
              </section>
            ))}
            {q.data.pages?.map((p) => (
              <section className="panel" key={p.id}>
                <h2>{p.name}</h2>
                <p>
                  Page {p.id}{" "}
                  {p.instagram_name
                    ? `· Instagram @${p.instagram_name}`
                    : p.instagram_id
                      ? `· Instagram ${p.instagram_id}`
                      : "· Instagram association unavailable"}
                </p>
                <p>
                  {p.enabled
                    ? "Synchronization active"
                    : "Synchronization paused"}{" "}
                  ·{" "}
                  {p.subscribed
                    ? "Webhook subscription confirmed"
                    : "Webhook subscription not confirmed"}{" "}
                  · Checked {date(p.last_checked_at)}
                </p>
                {p.error_code && (
                  <ErrorBox error={p.error_code.replaceAll("_", " ")} />
                )}
                <div className="meta-actions">
                  <Button
                    variant="secondary"
                    disabled={
                      busy ||
                      !q.data.configured ||
                      q.data.connections.find((c) => c.id === p.connection_id)
                        ?.status !== "connected"
                    }
                    onClick={() =>
                      run(
                        () =>
                          api(`${metaApi}/pages/${p.id}`, {
                            method: "PATCH",
                            body: { enabled: !p.enabled },
                          }),
                        (r) => r.warning || "Page updated",
                      )
                    }
                  >
                    {p.enabled ? "Pause Page" : "Activate Page"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !q.data.configured}
                    onClick={() =>
                      run(
                        () =>
                          api(`${metaApi}/pages/${p.id}/forms`, {
                            method: "POST",
                            body: {},
                          }),
                        (r) =>
                          `${r.forms} forms found${r.truncated ? "; more are available in Meta" : ""}`,
                      )
                    }
                  >
                    Refresh forms
                  </Button>
                </div>
                <div className="meta-form-grid">
                  {q.data.forms
                    .filter((f) => f.page_id === p.id)
                    .map((f) => (
                      <FormMapping
                        key={f.id + JSON.stringify(f.mapping) + f.enabled}
                        form={f}
                        busy={busy}
                        save={(form, data) =>
                          run(
                            () =>
                              api(
                                `${metaApi}/forms/${form.id}${data ? "" : "/sync"}`,
                                {
                                  method: data ? "PATCH" : "POST",
                                  body: data || { days: 1 },
                                },
                              ),
                            (r) =>
                              data
                                ? "Form updated"
                                : `${r.queued} new submissions queued from the last day${r.truncated ? " (limit reached; history may be incomplete)" : ""}`,
                          )
                        }
                      />
                    ))}
                </div>
              </section>
            ))}
          </>
        )
      )}
      {disconnect && (
        <Modal
          title="Disconnect Meta"
          onClose={() => {
            if (!busy) setDisconnect(null);
          }}
        >
          <p>
            Stop synchronization and remove this connection's stored
            credentials? Existing customers and submission history remain.
          </p>
          <footer>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setDisconnect(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(
                  async () => {
                    const result = await api(
                      `${metaApi}/connections/${disconnect.id}`,
                      { method: "DELETE", body: {} },
                    );
                    setDisconnect(null);
                    return result;
                  },
                  (r) => r.message,
                )
              }
            >
              Disconnect
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}

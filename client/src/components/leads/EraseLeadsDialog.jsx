import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Button, Modal, ErrorBox, Loader } from "../common/UI";
// Delete instantly (update 069): leads in Deleted leads, or the leads a
// deleted file moved there, are erased now with every record. It cannot be
// undone, so the administrator types DELETE first.
//
// Update 071, for selected leads: the database first says what would go
// (which leads can be erased, which cannot and why, and their records).
// More than 50 asks a second time, for the number. The leads that can be
// erased are then erased 250 at a time, each checked again by the database;
// an error, or a lead that can no longer be erased, stops the rest, and the
// dialog says what was erased, kept, failed and left. Their files are
// reported apart: removed from storage now, still waiting, or failed; the
// dialog only closes by itself when nothing is left anywhere.
const BATCH = 250,
  LARGE = 50;
const n = (value) => (value ?? 0).toLocaleString("en-US");
const plural = (value, one, many = one + "s") =>
  `${n(value)} ${value === 1 ? one : many}`;
const records = [
  ["calls", "call", "calls"],
  ["recordings", "call recording", "call recordings"],
  ["notes", "note", "notes"],
  ["followups", "follow-up", "follow-ups"],
  ["visits", "site visit", "site visits"],
  ["deals", "deal", "deals"],
  ["documents", "KYC document", "KYC documents"],
];
const WAITING =
  "Waiting files are removed the next time Delete instantly is used, or by the background clean-up job when it runs. While that job is off, they stay in storage until then, or until an approved clean-up is run.";
// The files of a run, from each answer's storage report (update 071).
const noFiles = () => ({
  removed: { recordings: 0, documents: 0 },
  pending: { recordings: 0, documents: 0, more: false },
  failed: false,
  unknown: false,
});
function addFiles(files, answer) {
  const storage = answer?.storage;
  if (!storage) {
    // An answer without a report (before update 071) only says done or not.
    if (answer?.files_removed === false) files.unknown = true;
    return files;
  }
  files.removed.recordings += storage.removed?.recordings ?? 0;
  files.removed.documents += storage.removed?.documents ?? 0;
  if (storage.failed) files.failed = true;
  if (storage.pending) files.pending = storage.pending;
  else files.unknown = true;
  return files;
}
const waiting = (files) =>
  (files.pending?.recordings ?? 0) + (files.pending?.documents ?? 0);
const filesDone = (files) =>
  !files.failed && !files.unknown && waiting(files) === 0;
// What the toast needs about the files.
const fileNews = (files) => ({
  files_removed: filesDone(files),
  files_waiting: waiting(files),
  files_more: !!files.pending?.more,
  files_unknown: files.unknown,
});
// The files, in words: removed now, still waiting, failed or unconfirmed.
function FileLines({ files }) {
  const removed = files.removed.recordings + files.removed.documents,
    left = waiting(files);
  return (
    <>
      <li>
        {removed
          ? `Removed from storage now: ${plural(files.removed.recordings, "call recording")} and ${plural(files.removed.documents, "KYC file")}.`
          : "No files were removed from storage by this deletion."}
      </li>
      {left > 0 && (
        <li>
          Still waiting to be removed from storage: {n(left)}
          {files.pending.more ? " or more" : ""} files (
          {plural(files.pending.recordings, "call recording")},{" "}
          {plural(files.pending.documents, "KYC file")}), counting any left from
          earlier deletions. {WAITING}
        </li>
      )}
      {files.failed && (
        <li>
          Storage reported an error, so removal stopped. The files not removed
          stay queued.
        </li>
      )}
      {files.unknown && (
        <li>
          Whether every file has left storage could not be confirmed. {WAITING}
        </li>
      )}
      {filesDone(files) && removed > 0 && <li>No files are left to remove.</li>}
    </>
  );
}
function FileErase({ file, onClose, onErased }) {
  const [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    // An answer whose files are not all gone, shown before closing.
    [answer, setAnswer] = useState(null);
  const pending = useRef(false);
  const close = () => {
    if (pending.current) return;
    if (answer)
      onErased({ ...answer, ...fileNews(addFiles(noFiles(), answer)) });
    else onClose();
  };
  if (answer)
    return (
      <Modal title="Delete permanently: finished" onClose={close}>
        <div className="erase-summary" role="status">
          <p>
            <b>
              {plural(answer.erased, "lead")} permanently deleted from the CRM
              database.
            </b>
          </p>
          <ul>
            {answer.failed > 0 && (
              <li>
                {plural(answer.failed, "lead")} kept (won deal or no longer
                here).
              </li>
            )}
            <FileLines files={addFiles(noFiles(), answer)} />
          </ul>
        </div>
        <footer>
          <Button onClick={close}>Done</Button>
        </footer>
      </Modal>
    );
  return (
    <Modal title="Delete permanently" onClose={close}>
      <p>
        The leads deleted with “{file.file_name}” and all their records (calls
        and recordings, notes, follow-ups, site visits, deals and documents)
        will be deleted from the CRM now. The file can no longer be restored.
      </p>
      <p>
        <b>This cannot be undone.</b> Leads with a won deal are kept.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || confirmation !== "DELETE") return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api(`/lead-imports/${file.id}/erase`, {
              method: "POST",
              body: {},
            });
            const files = addFiles(noFiles(), result);
            if (result.erased && !filesDone(files)) setAnswer(result);
            else onErased({ ...result, ...fileNews(files) });
          } catch (e) {
            setError(e.message);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          Type DELETE to confirm
          <input
            aria-label="Type DELETE to confirm"
            value={confirmation}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || confirmation !== "DELETE"}>
            {busy ? "Deleting…" : "Delete the file's leads permanently"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
// The end of a run: every number, in words.
function Summary({ run }) {
  const kept = run.kept.length;
  return (
    <div className="erase-summary" role="status">
      <p>
        <b>
          {plural(run.erased, "lead")} permanently deleted from the CRM
          database.
        </b>
      </p>
      <ul>
        {kept > 0 && (
          <li>
            {plural(kept, "lead")} kept:{" "}
            {Object.entries(
              run.kept.reduce(
                (all, r) => ({ ...all, [r]: (all[r] || 0) + 1 }),
                {},
              ),
            )
              .map(([reason, count]) => `${reason} (${n(count)})`)
              .join(", ")}
            .
          </li>
        )}
        {run.failed > 0 && (
          <li>
            {plural(run.failed, "lead")} not deleted: {run.error} They are still
            in Deleted leads.
          </li>
        )}
        {run.unknown > 0 && (
          <li>
            The last request failed ({run.error}) and could not be checked:
            reload Deleted leads to see which of its{" "}
            {plural(run.unknown, "lead")} are still there.
          </li>
        )}
        {run.remaining > 0 && (
          <li>
            {plural(run.remaining, "lead")} not attempted after the stop. They
            are still in Deleted leads.
          </li>
        )}
        {run.erased > 0 && <FileLines files={run.files} />}
      </ul>
    </div>
  );
}
function LeadsErase({ ids, onClose, onErased }) {
  const [preview, setPreview] = useState(null),
    [loadError, setLoadError] = useState(""),
    [step, setStep] = useState("review"),
    [confirmation, setConfirmation] = useState(""),
    [scale, setScale] = useState(""),
    [progress, setProgress] = useState(0),
    [run, setRun] = useState(null);
  const pending = useRef(false);
  useEffect(() => {
    let live = true;
    api("/leads/erase/preview", { method: "POST", body: { lead_ids: ids } })
      .then((p) => live && setPreview(p))
      .catch((e) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [ids]);
  const eligible = preview?.eligible ?? 0,
    large = eligible > LARGE,
    blocked =
      (preview?.won_deal ?? 0) +
      (preview?.not_in_bin ?? 0) +
      (preview?.missing ?? 0),
    alerts =
      preview && (preview.erased_today ?? 0) + eligible > preview.alert_over;
  const finish = (result) => {
    pending.current = false;
    onErased(result);
  };
  const close = () => {
    if (pending.current) return;
    if (run)
      finish({
        erased: run.erased,
        failed: run.kept.length,
        // Stopped: not erased, or not confirmed.
        left: run.failed + run.unknown + run.remaining,
        ...fileNews(run.files),
      });
    else onClose();
  };
  // Leaving the page mid-run would stop it between batches: ask first.
  useEffect(() => {
    if (step !== "running") return;
    const stay = (event) => event.preventDefault();
    window.addEventListener("beforeunload", stay);
    return () => window.removeEventListener("beforeunload", stay);
  }, [step]);
  async function erase() {
    if (pending.current || !preview) return;
    pending.current = true;
    setStep("running");
    const list = preview.eligible_ids;
    const done = {
      erased: 0,
      kept: [],
      failed: 0,
      unknown: 0,
      remaining: 0,
      files: noFiles(),
      error: "",
    };
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      try {
        const result = await api("/leads/erase", {
          method: "POST",
          body: { lead_ids: batch },
        });
        done.erased += result.erased;
        // The queues are shared, so the latest answer has the files left.
        if (result.erased) addFiles(done.files, result);
        for (const r of result.results || [])
          if (r.result !== "erased") done.kept.push(r.reason || "Kept");
        setProgress(i + batch.length);
        // A lead that could be erased a moment ago and cannot now (restored
        // or given a won deal meanwhile): stop and show it.
        if (result.failed) {
          done.remaining = list.length - i - batch.length;
          break;
        }
      } catch (e) {
        done.error = e.message;
        if (e.status >= 400 && e.status < 500) {
          // Refused before the database did anything (too many requests,
          // access, a check): the batch is untouched.
          done.failed = batch.length;
        } else {
          // The database erases a batch whole or not at all, but the answer
          // may have been lost after it finished: check what is left of it.
          try {
            const check = await api("/leads/erase/preview", {
              method: "POST",
              body: { lead_ids: batch },
            });
            done.erased += check.missing;
            done.failed = batch.length - check.missing;
          } catch {
            done.unknown = batch.length;
          }
          // Erased (or perhaps erased): their files as the queues show now.
          if (done.unknown || done.erased)
            try {
              done.files.pending = (await api("/leads/erase/storage")).pending;
            } catch {
              done.files.unknown = true;
            }
        }
        done.remaining = list.length - i - batch.length;
        break;
      }
    }
    // Everything erased and every file gone: close, as before; anything
    // else is shown first.
    if (
      done.erased === list.length &&
      !done.kept.length &&
      filesDone(done.files)
    )
      return finish({
        erased: done.erased,
        failed: 0,
        ...fileNews(done.files),
      });
    pending.current = false;
    setRun(done);
    setStep("done");
  }
  const title =
    step === "done" ? "Delete permanently: finished" : "Delete permanently";
  return (
    <Modal title={title} onClose={close}>
      {step === "done" ? (
        <>
          <Summary run={run} />
          <footer>
            <Button onClick={close}>Done</Button>
          </footer>
        </>
      ) : step === "running" ? (
        <p role="status" aria-live="polite">
          Deleting… {n(progress)} of {n(eligible)} done. Keep this page open.
        </p>
      ) : loadError ? (
        <>
          <ErrorBox error={loadError} />
          <footer>
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </footer>
        </>
      ) : !preview ? (
        <Loader />
      ) : eligible === 0 ? (
        <>
          <p>
            None of the {plural(preview.selected, "selected lead")} can be
            deleted permanently:{" "}
            {[
              preview.won_deal &&
                plural(preview.won_deal, "has a won deal", "have a won deal"),
              preview.not_in_bin && `${n(preview.not_in_bin)} restored since`,
              preview.missing &&
                `${n(preview.missing)} already deleted permanently`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </p>
          <footer>
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </footer>
        </>
      ) : step === "scale" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (scale.replace(/,/g, "") === String(eligible)) erase();
          }}
        >
          <p>
            <b>
              You are about to delete {plural(eligible, "lead")} permanently.
            </b>{" "}
            This is a large deletion. Every one of these leads, with all its
            records, will be gone from the CRM and cannot be restored.
          </p>
          <label>
            Type the number of leads ({eligible}) to confirm
            <input
              aria-label="Type the number of leads to confirm"
              inputMode="numeric"
              value={scale}
              autoComplete="off"
              onChange={(e) => setScale(e.target.value)}
            />
          </label>
          <footer>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep("review")}
            >
              Back
            </Button>
            <Button
              variant="danger"
              disabled={scale.replace(/,/g, "") !== String(eligible)}
            >
              Delete {plural(eligible, "lead")} permanently
            </Button>
          </footer>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmation !== "DELETE") return;
            if (large) setStep("scale");
            else erase();
          }}
        >
          <p>
            <b>
              {eligible === 1 ? "1 lead" : `${n(eligible)} leads`} will be
              deleted permanently
            </b>
            {preview.selected !== eligible
              ? ` (of the ${n(preview.selected)} selected)`
              : ""}
            , with everything recorded on {eligible === 1 ? "it" : "them"}:
          </p>
          <ul className="erase-records">
            {records.map(([key, one, many]) => (
              <li key={key}>
                {plural(preview.records?.[key] ?? 0, one, many)}
              </li>
            ))}
          </ul>
          {blocked > 0 && (
            <p>
              {plural(blocked, "selected lead")} will not be deleted:{" "}
              {[
                preview.won_deal && `${n(preview.won_deal)} with a won deal`,
                preview.not_in_bin &&
                  `${n(preview.not_in_bin)} restored since they were selected`,
                preview.missing &&
                  `${n(preview.missing)} already deleted permanently`,
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
          {preview.sheet_leads > 0 && (
            <p>
              {plural(preview.sheet_leads, "lead")} came from Google Sheets. The
              Sheet rows stay marked as imported, so the next sync does not
              bring them back.
            </p>
          )}
          {alerts && (
            <p>
              More than {preview.alert_over} permanent deletions in one day
              raise a security alert for administrators (
              {n(preview.erased_today)} so far today).
            </p>
          )}
          <p>
            <b>This cannot be undone</b>, and the leads cannot be restored from
            the CRM.
          </p>
          <label>
            Type DELETE to confirm
            <input
              aria-label="Type DELETE to confirm"
              value={confirmation}
              autoComplete="off"
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <footer>
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" disabled={confirmation !== "DELETE"}>
              {large
                ? "Continue"
                : `Delete ${eligible === 1 ? "lead" : `${n(eligible)} leads`} permanently`}
            </Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
export default function EraseLeadsDialog({ ids, file, onClose, onErased }) {
  return file ? (
    <FileErase file={file} onClose={onClose} onErased={onErased} />
  ) : (
    <LeadsErase ids={ids} onClose={onClose} onErased={onErased} />
  );
}

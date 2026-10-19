import { formatLeadNo } from "../../lib/formatLeadNo";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date, pkr, localISO, localInput } from "../../lib/api";
import { lostReasons, lostReasonLabel } from "../../lib/pipeline";
import VisitConflicts from "../visits/VisitConflicts";
import {
  Button,
  Modal,
  RecordForm,
  ErrorBox,
  Loader,
  Table,
  Pagination,
  Badge,
  useToast,
} from "./UI";
export function ActivityForm({ entity, leadId, initial, onSave }) {
  const leads = useQuery({
    queryKey: ["lead-options"],
    queryFn: ({ signal }) => api("/leads?limit=100", { signal }),
    enabled: !leadId,
  });
  const properties = useQuery({
    queryKey: ["property-options"],
    queryFn: ({ signal }) => api("/properties?limit=100", { signal }),
    enabled: entity !== "followups",
  });
  const fields = [
    ...(!leadId
      ? [
          {
            key: "lead_id",
            label: "Lead (first 100; use lead detail for other leads)",
            required: true,
            options: (leads.data?.data || []).map((l) => ({
              value: l.id,
              label: `${formatLeadNo(l.lead_no)} · ${l.name}`,
            })),
          },
        ]
      : []),
    ...(entity !== "followups"
      ? [
          {
            key: "property_id",
            label: "Property",
            required: true,
            options: (properties.data?.data || []).map((p) => ({
              value: p.id,
              label: p.title,
            })),
          },
        ]
      : []),
    ...(entity === "deals"
      ? [
          {
            key: "stage",
            label: "Stage",
            required: true,
            options: ["discussion", "negotiation", "won", "lost"],
            default: "discussion",
          },
          {
            key: "expected_value",
            label: "Expected / closed value (PKR)",
            type: "number",
            required: true,
          },
          {
            key: "close_date",
            label: "Close date (required when won)",
            type: "date",
          },
          {
            key: "lost_reason",
            label: "Lost reason (required when lost)",
            options: lostReasons,
          },
          {
            key: "lost_note",
            label: "Lost note (max 500 characters)",
            type: "textarea",
          },
        ]
      : [
          {
            key: entity === "followups" ? "due_at" : "scheduled_at",
            label: "Date and time (Asia/Karachi)",
            type: "datetime-local",
            required: true,
          },
          {
            key: "status",
            label: "Status",
            required: true,
            default: entity === "followups" ? "pending" : "scheduled",
            options:
              entity === "followups"
                ? ["pending", "completed", "cancelled"]
                : ["scheduled", "completed", "cancelled", "no-show"],
          },
        ]),
    { key: "notes", label: "Notes", type: "textarea" },
  ];
  const timekey = entity === "followups" ? "due_at" : "scheduled_at";
  return (
    <RecordForm
      fields={fields}
      initial={
        initial
          ? { ...initial, [timekey]: localInput(initial[timekey]) }
          : undefined
      }
      onSave={(data) => {
        const body = { ...data, lead_id: leadId || data.lead_id };
        if (entity === "deals") {
          body.close_date = data.close_date || null;
          if (data.stage === "won" && !body.close_date)
            throw new Error("Won deals require a close date");
          if (data.stage === "lost" && !data.lost_reason)
            throw new Error("Choose a lost reason");
          if ((data.lost_note || "").trim().length > 500)
            throw new Error("Use 500 characters or fewer for the lost note");
          body.lost_reason = data.stage === "lost" ? data.lost_reason : null;
          body.lost_note =
            data.stage === "lost" ? (data.lost_note || "").trim() : null;
        } else body[timekey] = localISO(data[timekey]);
        return onSave(body);
      }}
    >
      {entity === "visits"
        ? ({ values }) => (
            <VisitConflicts
              leadId={leadId || values.lead_id}
              at={values.scheduled_at}
              exclude={initial?.id}
            />
          )
        : null}
    </RecordForm>
  );
}
export default function RecordsPage({
  entity,
  title,
  description,
  viewSwitch = null,
}) {
  const [page, setPage] = useState(1),
    [view, setView] = useState(""),
    [modal, setModal] = useState(null);
  const qc = useQueryClient(),
    toast = useToast();
  const params = new URLSearchParams({
    page,
    ...(view ? (entity === "followups" ? { view } : { status: view }) : {}),
  });
  const q = useQuery({
    queryKey: [entity, params.toString()],
    queryFn: ({ signal }) => api("/" + entity + "?" + params, { signal }),
  });
  const columns = [
    {
      key: "lead_id",
      label: "Lead",
      render: (r) => (
        <Link to={"/leads/" + r.lead_id}>
          {formatLeadNo(r.leads?.lead_no)} · {r.leads?.name || "Open customer"}{" "}
          ↗
        </Link>
      ),
    },
    ...(entity === "deals"
      ? [
          {
            key: "stage",
            label: "Stage",
            render: (r) => <Badge value={r.stage} />,
          },
          {
            key: "expected_value",
            label: "Value",
            render: (r) => pkr(r.expected_value),
          },
          { key: "close_date", label: "Close date" },
          {
            key: "lost_reason",
            label: "Lost reason",
            render: (row) => lostReasonLabel(row.lost_reason),
          },
        ]
      : [
          {
            key: entity === "followups" ? "due_at" : "scheduled_at",
            label: entity === "followups" ? "Due" : "Scheduled",
            render: (r) => date(r.due_at || r.scheduled_at),
          },
          {
            key: "status",
            label: "Status",
            render: (r) => <Badge value={r.status} />,
          },
        ]),
    { key: "notes", label: "Notes" },
    {
      key: "actions",
      label: "Actions",
      render: (r) => (
        <Button variant="secondary" onClick={() => setModal(r)}>
          Edit
        </Button>
      ),
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PLAN YOUR NEXT MOVE</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <Button onClick={() => setModal({})}>
          + Add{" "}
          {entity === "followups"
            ? "follow-up"
            : entity === "visits"
              ? "visit"
              : "deal"}
        </Button>
      </div>
      {viewSwitch}
      <section className="panel">
        {entity !== "deals" && (
          <div className="toolbar">
            <select
              aria-label="Filter records"
              value={view}
              onChange={(e) => {
                setView(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All records</option>
              {(entity === "followups"
                ? ["due", "overdue", "upcoming", "completed"]
                : ["scheduled", "completed", "cancelled", "no-show"]
              ).map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
        )}
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <>
            <Table
              showSerial
              page={page}
              count={q.data?.count}
              columns={columns}
              rows={q.data?.data || []}
            />
            <Pagination page={page} count={q.data?.count} onPage={setPage} />
          </>
        )}
      </section>
      {modal && (
        <Modal
          title={modal.id ? "Edit record" : "Create record"}
          onClose={() => setModal(null)}
        >
          <ActivityForm
            entity={entity}
            initial={modal.id ? modal : undefined}
            onSave={async (data) => {
              await api("/" + entity + (modal.id ? "/" + modal.id : ""), {
                method: modal.id ? "PATCH" : "POST",
                body: data,
              });
              invalidateWorkspace(qc);
              toast("Record saved");
              setModal(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}

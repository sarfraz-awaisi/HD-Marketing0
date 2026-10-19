import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  correctionTypeLabel,
  invalidateAttendance,
  leaveTypeLabel,
  pkTime,
} from "../../lib/attendance";
import { dayLabel } from "../../lib/calendar";
import {
  Button,
  ErrorBox,
  Loader,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
import { RequestBadge } from "./Badges";
import ReviewDialog from "./ReviewDialog";
// Leave or correction requests for review. An administrator cannot review
// their own request; another administrator must.
export default function AdminRequests({ kind }) {
  const { user } = useAuth();
  const qc = useQueryClient(),
    toast = useToast();
  const [status, setStatus] = useState("pending"),
    [page, setPage] = useState(1),
    [reviewing, setReviewing] = useState(null);
  const base =
    kind === "leave"
      ? "/admin/attendance/leave"
      : "/admin/attendance/corrections";
  const q = useQuery({
    queryKey: ["attendance-admin", kind, status, page],
    queryFn: ({ signal }) =>
      api(
        base +
          "?" +
          new URLSearchParams({
            page,
            limit: 20,
            ...(status ? { status } : {}),
          }),
        { signal },
      ),
  });
  const rows = Array.isArray(q.data?.data) ? q.data.data : [];
  async function review(decision, note) {
    await api(`${base}/${reviewing.id}/review`, {
      method: "POST",
      body: { decision, ...(note ? { note } : {}) },
    });
    setReviewing(null);
    invalidateAttendance(qc);
    toast(decision === "approved" ? "Request approved" : "Request rejected");
  }
  const leave = kind === "leave";
  return (
    <>
      <div className="toolbar">
        <select
          aria-label="Request status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="pending">Waiting for review</option>
          <option value="approved">Approved</option>
          <option value="rejected">Not approved</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All requests</option>
        </select>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <>
          <Table
            rows={rows}
            columns={[
              {
                key: "employee",
                label: "Employee",
                render: (r) => (
                  <span className="attendance-person">
                    <b>{r.employee_name}</b>
                    <small>
                      {r.employee_uid ? `UID ${r.employee_uid} · ` : ""}
                      {r.employee_role === "admin" ? "Admin" : "Agent"}
                    </small>
                  </span>
                ),
              },
              leave
                ? {
                    key: "dates",
                    label: "Dates",
                    render: (r) => (
                      <span>
                        {r.start_date === r.end_date
                          ? dayLabel(r.start_date)
                          : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`}
                        <small className="block-muted">
                          {leaveTypeLabel(r.leave_type)}
                        </small>
                      </span>
                    ),
                  }
                : {
                    key: "change",
                    label: "Change",
                    render: (r) => (
                      <span>
                        {dayLabel(r.attendance_date)} ·{" "}
                        {correctionTypeLabel(r.correction_type)}
                        <small className="block-muted">
                          Was: in {pkTime(r.original_check_in_at)}, out{" "}
                          {pkTime(r.original_check_out_at)}
                        </small>
                        <small className="block-muted">
                          Asked:{" "}
                          {r.requested_check_in_at
                            ? `in ${pkTime(r.requested_check_in_at)}`
                            : ""}
                          {r.requested_check_in_at && r.requested_check_out_at
                            ? ", "
                            : ""}
                          {r.requested_check_out_at
                            ? `out ${pkTime(r.requested_check_out_at)}`
                            : ""}
                        </small>
                      </span>
                    ),
                  },
              { key: "reason", label: "Reason" },
              {
                key: "created_at",
                label: "Requested",
                render: (r) => date(r.created_at),
              },
              {
                key: "status",
                label: "Status",
                render: (r) => (
                  <span>
                    <RequestBadge status={r.status} />
                    {r.reviewer_name && (
                      <small className="block-muted">
                        by {r.reviewer_name}
                      </small>
                    )}
                    {r.review_note && (
                      <small className="block-muted">“{r.review_note}”</small>
                    )}
                  </span>
                ),
              },
              {
                key: "review",
                label: "Review",
                render: (r) =>
                  r.status !== "pending" ? (
                    "—"
                  ) : r.user_id === user.id ? (
                    <small>
                      Another administrator must review your own request
                    </small>
                  ) : (
                    <Button onClick={() => setReviewing(r)}>Review</Button>
                  ),
              },
            ]}
          />
          <Pagination
            page={page}
            count={q.data.count}
            limit={20}
            onPage={setPage}
          />
        </>
      )}
      {reviewing && (
        <ReviewDialog
          title={
            leave ? "Review leave request" : "Review attendance correction"
          }
          onReview={review}
          onClose={() => setReviewing(null)}
        >
          <dl className="profile-details">
            <div>
              <dt>Employee</dt>
              <dd>{reviewing.employee_name}</dd>
            </div>
            {leave ? (
              <div>
                <dt>Leave</dt>
                <dd>
                  {leaveTypeLabel(reviewing.leave_type)},{" "}
                  {dayLabel(reviewing.start_date)} –{" "}
                  {dayLabel(reviewing.end_date)}
                </dd>
              </div>
            ) : (
              <>
                <div>
                  <dt>Date</dt>
                  <dd>{dayLabel(reviewing.attendance_date)}</dd>
                </div>
                <div>
                  <dt>Original</dt>
                  <dd>
                    In {pkTime(reviewing.original_check_in_at)}, out{" "}
                    {pkTime(reviewing.original_check_out_at)}
                  </dd>
                </div>
                <div>
                  <dt>Proposed</dt>
                  <dd>
                    In{" "}
                    {pkTime(
                      reviewing.requested_check_in_at ||
                        reviewing.original_check_in_at,
                    )}
                    , out{" "}
                    {pkTime(
                      reviewing.requested_check_out_at ||
                        reviewing.original_check_out_at,
                    )}
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>Reason</dt>
              <dd>{reviewing.reason}</dd>
            </div>
          </dl>
        </ReviewDialog>
      )}
    </>
  );
}

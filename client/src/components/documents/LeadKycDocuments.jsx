import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../context/AuthContext";
import { api, download } from "../../lib/api";
import { Button, ErrorBox, Loader, Pagination } from "../common/UI";
export default function LeadKycDocuments({ leadId }) {
  const { user } = useAuth(),
    [page, setPage] = useState(1),
    [downloading, setDownloading] = useState(null),
    [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["documents", user.id, user.role, "kyc", leadId, page],
    queryFn: () =>
      api(
        "/documents?" +
          new URLSearchParams({
            category: "client_kyc",
            lead_id: leadId,
            page,
          }),
      ),
  });
  async function getFile(doc, file) {
    if (downloading) return;
    setDownloading(file.id);
    setError("");
    try {
      download(
        await api(`/documents/${doc.id}/files/${file.id}/download`, {
          download: true,
        }),
        file.file_name,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(null);
    }
  }
  return (
    <section className="panel lead-kyc-documents">
      <h2>KYC documents</h2>
      <ErrorBox error={q.error || error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : !q.data?.data?.length ? (
        <p>No KYC documents linked to this client.</p>
      ) : (
        <>
          <ul className="knowledge-file-list">
            {q.data.data.map((doc) => (
              <li key={doc.id}>
                <div>
                  <Link to={`/documents/${doc.id}`}>{doc.title}</Link>
                  {doc.files?.map((file) => (
                    <div className="kyc-file-row" key={file.id}>
                      <span>{file.file_name}</span>
                      <Button
                        variant="secondary"
                        disabled={!!downloading}
                        onClick={() => getFile(doc, file)}
                      >
                        {downloading === file.id ? "Downloading…" : "Download"}
                      </Button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} count={q.data.count} onPage={setPage} />
        </>
      )}
    </section>
  );
}

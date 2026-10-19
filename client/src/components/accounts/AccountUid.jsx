import { Copy } from "lucide-react";
import { useToast } from "../common/UI";
import { copyText } from "../../lib/accountFields";
// Read-only business UID with a copy action. The UID comes from Supabase.
export default function AccountUid({ uid }) {
  const toast = useToast();
  if (!uid) return <span className="account-uid-missing">Not assigned</span>;
  return (
    <span className="account-uid">
      <span className="account-uid-value">{uid}</span>
      <button
        type="button"
        className="icon-button account-uid-copy"
        aria-label={`Copy UID ${uid}`}
        title="Copy UID"
        onClick={async () =>
          toast(
            (await copyText(String(uid)))
              ? `UID ${uid} copied.`
              : "Copy failed. Select the UID and copy it manually.",
          )
        }
      >
        <Copy size={15} aria-hidden="true" />
      </button>
    </span>
  );
}

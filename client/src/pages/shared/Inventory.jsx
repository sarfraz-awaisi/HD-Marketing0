import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../../components/common/UI";
import InventoryList from "../../components/inventory/InventoryList";
import InventoryStats from "../../components/inventory/InventoryStats";
import AgentDirectory from "../../components/inventory/AgentDirectory";
import "../../styles/dashboard.css";

// Property inventory (update 041). Administrators manage the company
// inventory and read every agent's; agents manage their own and read the
// company's. The server enforces all of this; tabs only arrange the views.
const tabsFor = (admin) =>
  admin
    ? [
        ["company", "Admin properties"],
        ["agents", "Agent inventories"],
      ]
    : [
        ["mine", "My properties"],
        ["company", "Admin inventory"],
      ];
function Tabs({ tabs, tab, onChange }) {
  const refs = useRef({});
  function onKeyDown(event) {
    const keys = tabs.map(([key]) => key);
    const index = keys.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? keys[(index + 1) % keys.length]
        : event.key === "ArrowLeft"
          ? keys[(index - 1 + keys.length) % keys.length]
          : event.key === "Home"
            ? keys[0]
            : event.key === "End"
              ? keys.at(-1)
              : null;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  }
  return (
    <div
      className="inventory-tabs"
      role="tablist"
      aria-label="Inventory sections"
      onKeyDown={onKeyDown}
    >
      {tabs.map(([key, label]) => (
        <button
          key={key}
          ref={(el) => (refs.current[key] = el)}
          type="button"
          role="tab"
          id={`inventory-tab-${key}`}
          aria-selected={tab === key}
          aria-controls="inventory-panel"
          tabIndex={tab === key ? 0 : -1}
          className={tab === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
export default function Inventory() {
  const { user } = useAuth(),
    admin = user.role === "admin";
  const [params, setParams] = useSearchParams();
  const tabs = tabsFor(admin);
  const tab = tabs.some(([key]) => key === params.get("tab"))
    ? params.get("tab")
    : tabs[0][0];
  const agentId = admin && tab === "agents" ? params.get("agent") : null;
  const open = (next) => setParams(next, { replace: false });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE RIGHT PLACE FOR EVERY CUSTOMER</span>
          <h1>Inventory</h1>
          <p>
            {admin
              ? "Manage the company inventory and review every agent's listings."
              : "Keep your own listings up to date and browse the company inventory."}
          </p>
        </div>
      </div>
      <InventoryStats />
      <Tabs tabs={tabs} tab={tab} onChange={(key) => open({ tab: key })} />
      <section
        id="inventory-panel"
        role="tabpanel"
        aria-labelledby={`inventory-tab-${tab}`}
        className="inventory-panel"
      >
        {tab === "mine" && (
          <InventoryList
            key="mine"
            scope="mine"
            canAdd
            ownership="agent"
            notice="Only you and administrators can see these properties."
            emptyText="You have not added any properties yet. Choose + Add property to start your inventory."
          />
        )}
        {tab === "company" && (
          <InventoryList
            key="company"
            scope="company"
            canAdd={admin}
            ownership="company"
            notice={
              admin
                ? "Every agent can view these listings. Only administrators can change them."
                : "Listings added by administrators. You can view them but not change them."
            }
          />
        )}
        {tab === "agents" &&
          (agentId ? (
            <>
              <Button
                variant="secondary"
                onClick={() => open({ tab: "agents" })}
              >
                ← All agents
              </Button>
              <InventoryList
                key={agentId}
                scope="agent"
                agentId={agentId}
                notice="Agent inventories are read-only for administrators."
                emptyText="This agent has not added any properties yet."
              />
            </>
          ) : (
            <AgentDirectory
              onOpen={(agent) => open({ tab: "agents", agent: agent.id })}
            />
          ))}
      </section>
    </>
  );
}

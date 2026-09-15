"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Toggle } from "@/shared/components";

// Prepaid pool editor for an API key: model allowlist + token pool + expiry.
// Used for both create (initial = null) and edit (initial = existing key).
// The parent remounts this via `key`, so props seed state directly — no syncing
// effect (a setState-in-effect here would cascade renders).
const QUICK_TOKENS = [
  { label: "+1M", value: 1000000 },
  { label: "+5M", value: 5000000 },
  { label: "+25M", value: 25000000 },
];

export default function ApiKeyPlanModal({ isOpen, onClose, initial, onSaved }) {
  const editing = !!initial?.id;
  const lim = initial?.limits || null;

  const [name, setName] = useState(initial?.name || "");
  const [limited, setLimited] = useState(!!lim);
  const [models, setModels] = useState(lim?.models ? [...lim.models] : []);
  const [catalog, setCatalog] = useState([]);
  const [search, setSearch] = useState("");
  const [totalTokens, setTotalTokens] = useState(lim?.totalTokens || 1000000);
  const [expiresAt, setExpiresAt] = useState(lim?.expiresAt ? String(lim.expiresAt).slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    // Catalog = static/aliased models + custom models. Compatible-node custom
    // models are stored under the node id, so remap them to the node's prefix
    // (that's the alias users actually call).
    Promise.all([
      fetch("/api/models").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/api/models/custom").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("/api/provider-nodes").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]).then(([modelData, customData, nodeData]) => {
      if (!alive) return;
      const prefixByNodeId = {};
      for (const n of nodeData.nodes || []) if (n?.id && n?.prefix) prefixByNodeId[n.id] = n.prefix;

      const ids = new Set();
      for (const m of modelData.models || []) {
        const id = m.routedModel || m.fullModel;
        if (id) ids.add(id);
      }
      for (const m of customData.models || []) {
        if (!m?.id) continue;
        const prefix = prefixByNodeId[m.providerAlias] || m.providerAlias;
        ids.add(`${prefix}/${m.id}`);
      }
      setCatalog([...ids].sort());
    });
    return () => { alive = false; };
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? catalog.filter((m) => m.toLowerCase().includes(q)) : catalog;
    return list.slice(0, 300);
  }, [catalog, search]);

  const used = lim?.usedTokens || 0;
  const total = lim?.totalTokens || 0;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

  const submit = async () => {
    if (!name.trim()) return setError("Name is required");
    setSaving(true);
    setError("");
    try {
      const limits = limited
        ? { models: models.length ? models : null, totalTokens, expiresAt: expiresAt || null }
        : null;
      const res = await fetch(editing ? `/api/keys/${initial.id}` : "/api/keys", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), limits }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Request failed");
      onSaved(await res.json());
    } catch (e) {
      setError(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={editing ? "Edit API Key Plan" : "Create API Key"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input label="Key Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer A" />

        <div className="flex items-center justify-between py-2 border-y border-border">
          <div>
            <p className="text-sm font-medium">Prepaid token pool</p>
            <p className="text-xs text-text-muted">Off = unlimited (legacy behaviour)</p>
          </div>
          <Toggle checked={limited} onChange={() => setLimited((v) => !v)} />
        </div>

        {limited && (
          <>
            {editing && total > 0 && (
              <div>
                <div className="flex justify-between text-xs text-text-muted mb-1">
                  <span>Used {used.toLocaleString()} / {total.toLocaleString()}</span>
                  <span className={pct >= 90 ? "text-red-500 font-medium" : ""}>{pct}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : "bg-primary"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )}

            <div>
              <p className="text-sm font-medium mb-2">Allowed models</p>
              <p className="text-xs text-text-muted mb-2">None selected = every model allowed.</p>
              <Input placeholder="Search models..." value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="mt-2 max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {filtered.length === 0 ? (
                  <p className="p-3 text-xs text-text-muted">No models found.</p>
                ) : (
                  filtered.map((m) => (
                    <label key={m} className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-sidebar/50">
                      <input
                        type="checkbox"
                        checked={models.includes(m)}
                        onChange={() =>
                          setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
                        }
                      />
                      <code className="font-mono truncate">{m}</code>
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-text-muted mt-1">{models.length} selected</p>
            </div>

            <div>
              <Input
                label="Total tokens"
                type="number"
                value={totalTokens}
                onChange={(e) => setTotalTokens(Number(e.target.value) || 0)}
                hint="Cached tokens are free — only new prompt + output tokens are billed."
              />
              <div className="flex gap-2 mt-2">
                {QUICK_TOKENS.map((q) => (
                  <Button key={q.label} size="sm" variant="secondary" onClick={() => setTotalTokens((v) => (v || 0) + q.value)}>
                    {q.label}
                  </Button>
                ))}
                <Button size="sm" variant="secondary" onClick={() => setTotalTokens(0)}>Reset 0</Button>
              </div>
            </div>

            <Input
              label="Expires at (optional)"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex gap-2">
          <Button onClick={submit} fullWidth disabled={saving || !name.trim()}>
            {saving ? "Saving..." : editing ? "Save" : "Create"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

ApiKeyPlanModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  initial: PropTypes.object,
  onSaved: PropTypes.func.isRequired,
};

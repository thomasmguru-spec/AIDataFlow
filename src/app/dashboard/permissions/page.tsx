'use client';

import { Card, Badge } from '@/components/ui';
import { ShieldCheck, ShieldOff, RefreshCw, Save, Lock } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';

type Role = 'admin' | 'manager' | 'validator' | 'user';

interface PermissionsData {
  roles: Role[];
  capabilities: string[];
  labels: Record<string, string>;
  matrix: Record<Role, Record<string, boolean>>;
}

const ROLE_BADGE: Record<Role, string> = {
  admin: 'bg-purple-100 text-purple-800',
  manager: 'bg-indigo-100 text-indigo-800',
  validator: 'bg-blue-100 text-blue-800',
  user: 'bg-slate-100 text-slate-700',
};

// Capabilities that are forced-on for the admin role and cannot be unchecked.
const ADMIN_LOCKED = new Set(['admin:manage_users', 'admin:manage_permissions']);

export default function PermissionsPage() {
  const [data, setData] = useState<PermissionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<Role | null>(null);
  const [dirty, setDirty] = useState<Record<Role, boolean>>({
    admin: false, manager: false, validator: false, user: false,
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/permissions');
      if (r.status === 403) {
        setError('Forbidden: only admins can manage permissions.');
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setDirty({ admin: false, manager: false, validator: false, user: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load permissions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  function toggle(role: Role, cap: string) {
    if (!data) return;
    if (role === 'admin' && ADMIN_LOCKED.has(cap)) return; // locked
    setData({
      ...data,
      matrix: {
        ...data.matrix,
        [role]: { ...data.matrix[role], [cap]: !data.matrix[role][cap] },
      },
    });
    setDirty(d => ({ ...d, [role]: true }));
  }

  async function saveRole(role: Role) {
    if (!data) return;
    setSavingRole(role);
    try {
      const r = await fetch('/api/admin/permissions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, capabilities: data.matrix[role] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Save failed');
      toast.success(`Saved ${role} permissions`);
      setDirty(d => ({ ...d, [role]: false }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSavingRole(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Permissions</h1>
        <Card>
          <div className="p-8 text-center text-slate-500">
            <ShieldOff className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p>{error}</p>
          </div>
        </Card>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Permissions</h1>
        <Card>
          <div className="p-12 text-center text-slate-500">
            <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading...
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Role Permissions</h1>
          <p className="text-slate-500 mt-1">
            Control which capabilities each role grants. New users created with a role
            inherit these permissions automatically.
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-4 py-3 font-medium">Capability</th>
                {data.roles.map(role => (
                  <th key={role} className="px-4 py-3 font-medium text-center">
                    <Badge className={ROLE_BADGE[role]}>{role}</Badge>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.capabilities.map(cap => (
                <tr key={cap} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-slate-500">{cap}</div>
                    <div className="text-slate-700">{data.labels[cap]}</div>
                  </td>
                  {data.roles.map(role => {
                    const checked = !!data.matrix[role]?.[cap];
                    const locked = role === 'admin' && ADMIN_LOCKED.has(cap);
                    return (
                      <td key={role} className="px-4 py-3 text-center">
                        <label className={`inline-flex items-center justify-center ${locked ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked}
                            onChange={() => toggle(role, cap)}
                            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-50"
                          />
                          {locked && <Lock className="w-3 h-3 ml-1 text-slate-400" />}
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200">
                <td className="px-4 py-3 text-xs text-slate-500">
                  <ShieldCheck className="w-3 h-3 inline mr-1" />
                  Save each role separately
                </td>
                {data.roles.map(role => (
                  <td key={role} className="px-4 py-3 text-center">
                    <button
                      onClick={() => saveRole(role)}
                      disabled={!dirty[role] || savingRole === role}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded"
                    >
                      {savingRole === role ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Save className="w-3 h-3" />
                      )}
                      Save
                    </button>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <Card>
        <div className="p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-900 mb-2">How it works</p>
          <ul className="list-disc list-inside space-y-1 text-slate-600">
            <li>Checkboxes set the <strong>default</strong> capabilities for that role.</li>
            <li>Existing users with the role get the change immediately (cached up to 15s).</li>
            <li>To grant or revoke a single capability for one user, use the section below.</li>
            <li>Admin core capabilities (<code>admin:manage_users</code>, <code>admin:manage_permissions</code>) are locked to prevent lockout.</li>
          </ul>
        </div>
      </Card>

      <UserOverridesSection />
    </div>
  );
}

// =============================================================
// Per-user overrides — dropdown of non-admin users + capability grid
// =============================================================

interface SystemUserLite {
  id: string;
  email: string | null;
  full_name: string;
  role: Role;
  is_active: boolean;
}

interface PermissionRow {
  capability: string;
  label: string;
  role_default: boolean;
  override: boolean | null;
  effective: boolean;
}

function UserOverridesSection() {
  const [users, setUsers] = useState<SystemUserLite[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [perms, setPerms] = useState<{ user: { id: string; email: string; full_name: string; role: Role }; permissions: PermissionRow[] } | null>(null);
  const [permsLoading, setPermsLoading] = useState(false);
  const [edits, setEdits] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Fetch user list (admin only); filter out admins as requested.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/admin/users');
        const j = await r.json();
        const list: SystemUserLite[] = (j.data || [])
          .filter((u: any) => u.is_active && u.role !== 'admin')
          .map((u: any) => ({ id: u.id, email: u.email, full_name: u.full_name, role: u.role, is_active: u.is_active }));
        setUsers(list);
      } finally { setUsersLoading(false); }
    })();
  }, []);

  // Fetch permissions for the selected user.
  useEffect(() => {
    if (!selectedId) { setPerms(null); setEdits({}); return; }
    setPermsLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/admin/users/${selectedId}/permissions`);
        const j = await r.json();
        if (!r.ok) { toast.error(j.error || 'Failed to load'); return; }
        setPerms(j);
        setEdits({});
      } finally { setPermsLoading(false); }
    })();
  }, [selectedId]);

  function setOverride(cap: string, value: boolean | null) {
    setEdits(e => ({ ...e, [cap]: value }));
  }
  function getCurrent(p: PermissionRow): boolean | null {
    return edits[p.capability] !== undefined ? edits[p.capability] : p.override;
  }
  function getEffective(p: PermissionRow): boolean {
    const cur = getCurrent(p);
    return cur === null ? p.role_default : cur;
  }

  async function save() {
    if (!selectedId || Object.keys(edits).length === 0) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/admin/users/${selectedId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: edits }),
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error || 'Save failed'); return; }
      toast.success('User permissions updated');
      // reload perms so UI reflects persisted state
      const r2 = await fetch(`/api/admin/users/${selectedId}/permissions`);
      const j2 = await r2.json();
      setPerms(j2);
      setEdits({});
    } finally { setSaving(false); }
  }

  return (
    <Card>
      <div className="p-4 border-b border-slate-100">
        <h2 className="text-lg font-semibold text-slate-900">Per-user permission overrides</h2>
        <p className="text-sm text-slate-500 mt-1">
          Pick a user (admins are excluded) and grant or revoke individual capabilities.
          Overrides win over the role default.
        </p>
      </div>

      <div className="p-4 flex flex-wrap items-center gap-3 border-b border-slate-100">
        <label className="text-sm font-medium text-slate-700">User:</label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={usersLoading}
          className="min-w-[280px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
        >
          <option value="">-- select a user --</option>
          {users.map(u => (
            <option key={u.id} value={u.id}>
              {u.full_name} ({u.email}) — {u.role}
            </option>
          ))}
        </select>
        {selectedId && perms && (
          <Badge className={ROLE_BADGE[perms.user.role] || ROLE_BADGE.user}>
            role: {perms.user.role}
          </Badge>
        )}
      </div>

      {!selectedId ? (
        <div className="p-8 text-center text-slate-500 text-sm">
          Select a user above to view and edit their effective permissions.
        </div>
      ) : permsLoading || !perms ? (
        <div className="p-8 text-center text-slate-500">
          <RefreshCw className="w-5 h-5 text-slate-300 mx-auto mb-2 animate-spin" /> Loading...
        </div>
      ) : (
        <>
          <div className="px-4 py-2 flex items-center justify-between border-b border-slate-100 bg-slate-50/50">
            <div className="text-xs text-slate-500">
              {(() => {
                const allowed = perms.permissions.filter(p => getEffective(p)).length;
                const total = perms.permissions.length;
                return showAll
                  ? `Showing all ${total} capabilities`
                  : `Showing ${allowed} allowed capabilit${allowed === 1 ? 'y' : 'ies'} (of ${total})`;
              })()}
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              Show all (including denied) so I can grant extras
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  <th className="px-4 py-2 font-medium">Capability</th>
                  <th className="px-4 py-2 font-medium text-center">Role default</th>
                  <th className="px-4 py-2 font-medium text-center">User override</th>
                  <th className="px-4 py-2 font-medium text-center">Effective</th>
                  <th className="px-4 py-2 font-medium text-center">Reset</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {perms.permissions
                  .filter(p => showAll || getEffective(p))
                  .map(p => {
                  const cur = getCurrent(p);
                  const eff = getEffective(p);
                  return (
                    <tr key={p.capability} className="hover:bg-slate-50">
                      <td className="px-4 py-2">
                        <div className="font-mono text-xs text-slate-500">{p.capability}</div>
                        <div className="text-slate-700">{p.label}</div>
                      </td>
                      <td className="px-4 py-2 text-center">
                        {p.role_default ? (
                          <ShieldCheck className="w-4 h-4 text-green-600 inline" />
                        ) : (
                          <ShieldOff className="w-4 h-4 text-slate-300 inline" />
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <select
                          value={cur === null ? '' : cur ? 'true' : 'false'}
                          onChange={(e) => {
                            const v = e.target.value;
                            setOverride(p.capability, v === '' ? null : v === 'true');
                          }}
                          className="text-xs px-2 py-1 rounded border border-slate-200 bg-white"
                        >
                          <option value="">(use role default)</option>
                          <option value="true">Grant</option>
                          <option value="false">Revoke</option>
                        </select>
                      </td>
                      <td className="px-4 py-2 text-center">
                        {eff ? (
                          <Badge className="bg-green-100 text-green-800">Allowed</Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-700">Denied</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          onClick={() => setOverride(p.capability, null)}
                          disabled={cur === null}
                          className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Reset
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="p-4 border-t border-slate-100 flex justify-end">
            <button
              onClick={save}
              disabled={saving || Object.keys(edits).length === 0}
              className="inline-flex items-center gap-1 px-4 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg disabled:opacity-50"
            >
              <Save className="w-4 h-4" /> {saving ? 'Saving...' : `Save${Object.keys(edits).length ? ` (${Object.keys(edits).length})` : ''}`}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

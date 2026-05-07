'use client';

import { Card, Badge } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import { Users as UsersIcon, RefreshCw, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';

type Role = 'admin' | 'manager' | 'validator' | 'user';

interface SystemUser {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_sign_in_at: string | null;
}

const ROLE_BADGE: Record<Role, string> = {
  admin: 'bg-purple-100 text-purple-800',
  manager: 'bg-indigo-100 text-indigo-800',
  validator: 'bg-blue-100 text-blue-800',
  user: 'bg-slate-100 text-slate-700',
};

export default function SystemUsersPage() {
  const [me, setMe] = useState<{ id: string | null; role: Role } | null>(null);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchMe = useCallback(async () => {
    const r = await fetch('/api/me');
    const j = await r.json();
    if (j.user) setMe({ id: j.user.id, role: j.user.role });
  }, []);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/users');
      if (r.status === 403) {
        setError('Forbidden: only admins can view this page.');
        setUsers([]);
        return;
      }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setUsers(j.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMe(); fetchUsers(); }, [fetchMe, fetchUsers]);

  async function updateUser(id: string, patch: Partial<SystemUser>) {
    const r = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json();
    if (!r.ok) { toast.error(j.error || 'Update failed'); return; }
    toast.success('User updated');
    fetchUsers();
  }

  async function deactivateUser(id: string) {
    if (!confirm('Deactivate this user? They will lose access immediately.')) return;
    const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok) { toast.error(j.error || 'Deactivate failed'); return; }
    toast.success('User deactivated');
    fetchUsers();
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">System Users</h1>
        <Card>
          <div className="p-8 text-center text-slate-500">
            <ShieldOff className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p>{error}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">System Users</h1>
          <p className="text-slate-500 mt-1">
            {users.length} user{users.length === 1 ? '' : 's'} \u2014 admin only
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition"
          >
            <UserPlus className="w-4 h-4" /> New User
          </button>
          <button
            onClick={fetchUsers}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Email</th>
                <th className="px-6 py-3 font-medium">Role</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Last Sign-in</th>
                <th className="px-6 py-3 font-medium">Created</th>
                <th className="px-6 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && users.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                  <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading users...
                </td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                  <UsersIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No users found
                </td></tr>
              ) : users.map(u => {
                const isMe = me?.id === u.id;
                return (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{u.full_name || '\u2014'}</div>
                      {isMe && <span className="text-xs text-brand-600">(you)</span>}
                    </td>
                    <td className="px-6 py-3 text-slate-600">{u.email || '\u2014'}</td>
                    <td className="px-6 py-3">
                      <select
                        value={u.role}
                        disabled={isMe}
                        onChange={(e) => updateUser(u.id, { role: e.target.value as Role })}
                        className="text-xs px-2 py-1 rounded border border-slate-200 bg-white disabled:bg-slate-50 disabled:cursor-not-allowed"
                      >
                        <option value="admin">admin</option>
                        <option value="manager">manager</option>
                        <option value="validator">validator</option>
                        <option value="user">user</option>
                      </select>
                      <Badge className={`ml-2 ${ROLE_BADGE[u.role] || ROLE_BADGE.user}`}>{u.role}</Badge>
                    </td>
                    <td className="px-6 py-3">
                      {u.is_active ? (
                        <Badge className="bg-green-100 text-green-800"><ShieldCheck className="w-3 h-3 mr-1 inline" />Active</Badge>
                      ) : (
                        <Badge className="bg-slate-200 text-slate-700"><ShieldOff className="w-3 h-3 mr-1 inline" />Inactive</Badge>
                      )}
                    </td>
                    <td className="px-6 py-3 text-slate-500 text-xs">
                      {u.last_sign_in_at ? formatDate(u.last_sign_in_at) : 'Never'}
                    </td>
                    <td className="px-6 py-3 text-slate-500 text-xs">{formatDate(u.created_at)}</td>
                    <td className="px-6 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        {u.is_active ? (
                          <button
                            disabled={isMe}
                            onClick={() => deactivateUser(u.id)}
                            className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 disabled:text-slate-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            disabled={isMe}
                            onClick={() => updateUser(u.id, { is_active: true })}
                            className="text-xs px-2 py-1 rounded text-green-700 hover:bg-green-50 disabled:text-slate-400 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                          >
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {showCreate && (
        <CreateUserModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); fetchUsers(); }} />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, full_name: fullName, role, password }),
    });
    const j = await r.json();
    setSubmitting(false);
    if (!r.ok) { toast.error(j.error || 'Create failed'); return; }
    toast.success('User created');
    onCreated();
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Create System User</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Full name</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required className="w-full px-3 py-2 rounded-lg border border-slate-300" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full px-3 py-2 rounded-lg border border-slate-300" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white">
              <option value="admin">admin</option>
              <option value="manager">manager</option>
              <option value="validator">validator</option>
              <option value="user">user</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} className="w-full px-3 py-2 rounded-lg border border-slate-300" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg disabled:opacity-50">
              {submitting ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

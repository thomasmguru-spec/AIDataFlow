'use client';

import { useEffect, useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

interface LineRow {
  id?: string;
  line_number: number;
  description: string | null;
  sku_code: string | null;
  sku_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  tax_amount?: number | null;
  line_total: number | null;
  returned_quantity?: number | null;
  credit_amount?: number | null;
  return_date?: string | null;
  return_reason?: string | null;
  _deleted?: boolean;
  _new?: boolean;
}

export function InvoiceEditModal({
  invoiceId,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [header, setHeader] = useState<{ invoice_number: string; vendor_name: string; invoice_date: string | null; subtotal: number; tax_amount: number; total_amount: number }>({
    invoice_number: '',
    vendor_name: '',
    invoice_date: null,
    subtotal: 0,
    tax_amount: 0,
    total_amount: 0,
  });
  const [lines, setLines] = useState<LineRow[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const r = await fetch(`/api/invoices/${invoiceId}`);
      const j = await r.json();
      if (!r.ok) { toast.error(j.error || 'Failed to load'); onClose(); return; }
      const inv = j.invoice;
      setHeader({
        invoice_number: inv.invoice_number ?? '',
        vendor_name: inv.vendor_name ?? '',
        invoice_date: inv.invoice_date ?? null,
        subtotal: Number(inv.subtotal ?? 0),
        tax_amount: Number(inv.tax_amount ?? 0),
        total_amount: Number(inv.total_amount ?? 0),
      });
      setLines((inv.invoice_lines || []).map((l: LineRow) => ({ ...l })));
      setLoading(false);
    })();
  }, [invoiceId, onClose]);

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, ...patch };
      // Recompute line_total client-side (server triggers also recompute, including credit_amount)
      if (
        patch.quantity != null ||
        patch.unit_price != null ||
        patch.returned_quantity != null ||
        patch.credit_amount != null
      ) {
        const q = Number(next.quantity ?? 0);
        const r = Number(next.returned_quantity ?? 0);
        const p = Number(next.unit_price ?? 0);
        const c = Number(next.credit_amount ?? 0);
        next.line_total = +(((q - r) * p) - c).toFixed(2);
      }
      return next;
    }));
  }

  function addLine() {
    setLines(prev => [...prev, {
      line_number: prev.length + 1,
      description: '', sku_code: '', sku_name: '',
      quantity: 1, unit_price: 0, line_total: 0,
      _new: true,
    }]);
  }

  function removeLine(idx: number) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, _deleted: true } : l));
  }

  async function save() {
    setSaving(true);

    // Client-side window check for returns: 7-30 days after invoice_date
    if (header.invoice_date) {
      const invDate = new Date(header.invoice_date);
      for (const l of lines) {
        if (l._deleted) continue;
        if (!l.return_date) continue;
        const retDate = new Date(l.return_date);
        const days = Math.floor((retDate.getTime() - invDate.getTime()) / 86400000);
        if (days < 7 || days > 30) {
          setSaving(false);
          toast.error(`Line ${l.line_number}: return date must be 7–30 days after invoice date (got ${days} days).`);
          return;
        }
      }
    }

    const editedLines = lines
      .filter(l => !l._deleted)
      .map(l => ({
        id: l._new ? undefined : l.id,
        line_number: l.line_number,
        description: l.description,
        sku_code: l.sku_code,
        sku_name: l.sku_name,
        quantity: l.quantity,
        unit_price: l.unit_price,
        line_total: l.line_total,
        returned_quantity: l.returned_quantity ?? 0,
        credit_amount: l.credit_amount ?? 0,
        return_date: l.return_date || null,
        return_reason: l.return_reason || null,
      }));

    const deleteIds = lines.filter(l => l._deleted && l.id && !l._new).map(l => l.id);

    const r = await fetch(`/api/invoices/${invoiceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          invoice_number: header.invoice_number,
          vendor_name: header.vendor_name,
          invoice_date: header.invoice_date,
        },
        lines: editedLines,
        delete_line_ids: deleteIds,
      }),
    });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) { toast.error(j.error || 'Save failed'); return; }
    toast.success('Invoice updated. Totals recomputed.');
    onSaved();
  }

  const visibleLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l._deleted);
  const previewSubtotal = visibleLines.reduce((s, { l }) => s + Number(l.line_total || 0), 0);
  const previewCredits = visibleLines.reduce((s, { l }) => s + Number(l.credit_amount || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">Edit Invoice</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-500">Loading...</div>
        ) : (
          <>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Invoice Number</label>
                  <input value={header.invoice_number} onChange={(e) => setHeader({ ...header, invoice_number: e.target.value })} className="w-full px-3 py-1.5 rounded border border-slate-300 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Vendor</label>
                  <input value={header.vendor_name} onChange={(e) => setHeader({ ...header, vendor_name: e.target.value })} className="w-full px-3 py-1.5 rounded border border-slate-300 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Invoice Date</label>
                  <input
                    type="date"
                    value={header.invoice_date ?? ''}
                    onChange={(e) => setHeader({ ...header, invoice_date: e.target.value || null })}
                    className="w-full px-3 py-1.5 rounded border border-slate-300 text-sm"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-slate-900">Line Items</h3>
                  <button onClick={addLine} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700">
                    <Plus className="w-3.5 h-3.5" /> Add line
                  </button>
                </div>
                <div className="overflow-x-auto border border-slate-200 rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-2 font-medium w-8">#</th>
                        <th className="px-2 py-2 font-medium">SKU</th>
                        <th className="px-2 py-2 font-medium">Description</th>
                        <th className="px-2 py-2 font-medium w-20">Qty</th>
                        <th className="px-2 py-2 font-medium w-24">Unit Price</th>
                        <th className="px-2 py-2 font-medium w-20" title="Returned quantity (must be ≤ Qty)">Ret. Qty</th>
                        <th className="px-2 py-2 font-medium w-24" title="Credit amount applied for return">Credit $</th>
                        <th className="px-2 py-2 font-medium w-32" title="Return date (must be 7–30 days after invoice date)">Return Date</th>
                        <th className="px-2 py-2 font-medium w-24">Line Total</th>
                        <th className="px-2 py-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleLines.length === 0 ? (
                        <tr><td colSpan={10} className="px-2 py-4 text-center text-slate-400">No line items</td></tr>
                      ) : visibleLines.map(({ l, i }) => (
                        <tr key={l.id ?? `new-${i}`}>
                          <td className="px-2 py-1 text-slate-500">{l.line_number}</td>
                          <td className="px-2 py-1">
                            <input value={l.sku_code ?? ''} onChange={(e) => updateLine(i, { sku_code: e.target.value })} className="w-full px-2 py-1 rounded border border-slate-200" />
                          </td>
                          <td className="px-2 py-1">
                            <input value={l.description ?? l.sku_name ?? ''} onChange={(e) => updateLine(i, { description: e.target.value })} className="w-full px-2 py-1 rounded border border-slate-200" />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" step="any" value={l.quantity ?? ''} onChange={(e) => updateLine(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} className="w-full px-2 py-1 rounded border border-slate-200 text-right" />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" step="any" value={l.unit_price ?? ''} onChange={(e) => updateLine(i, { unit_price: e.target.value === '' ? null : Number(e.target.value) })} className="w-full px-2 py-1 rounded border border-slate-200 text-right" />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              step="any"
                              min={0}
                              max={l.quantity ?? undefined}
                              value={l.returned_quantity ?? ''}
                              onChange={(e) => updateLine(i, { returned_quantity: e.target.value === '' ? null : Number(e.target.value) })}
                              className="w-full px-2 py-1 rounded border border-amber-200 bg-amber-50 text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="number"
                              step="any"
                              min={0}
                              value={l.credit_amount ?? ''}
                              onChange={(e) => updateLine(i, { credit_amount: e.target.value === '' ? null : Number(e.target.value) })}
                              className="w-full px-2 py-1 rounded border border-amber-200 bg-amber-50 text-right"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input
                              type="date"
                              value={l.return_date ?? ''}
                              onChange={(e) => updateLine(i, { return_date: e.target.value || null })}
                              className="w-full px-2 py-1 rounded border border-amber-200 bg-amber-50"
                              title="Return must occur 7–30 days after invoice date"
                            />
                          </td>
                          <td className="px-2 py-1 text-right font-medium">{Number(l.line_total ?? 0).toFixed(2)}</td>
                          <td className="px-2 py-1">
                            <button onClick={() => removeLine(i)} className="p-1 text-red-500 hover:bg-red-50 rounded">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-50">
                      <tr>
                        <td colSpan={6} className="px-2 py-2 text-right text-slate-500">Total Credits (returns)</td>
                        <td className="px-2 py-2 text-right font-semibold text-amber-700">{previewCredits.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right text-slate-500">Net Subtotal</td>
                        <td className="px-2 py-2 text-right font-semibold">{previewSubtotal.toFixed(2)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Subtotal, tax_amount, total_amount, and total_returns/total_credits on the invoice are auto-recomputed by the database when you save.
                  Returns must occur within 7–30 days of the invoice date.
                </p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
              <button onClick={save} disabled={saving} className="px-4 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg disabled:opacity-50">
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import type { DocumentType, ValidationCheck } from '@/types';
import type { createAdminClient } from '@/lib/supabase/admin';

export interface ValidationOutput {
  allPassed: boolean;
  totalChecks: number;
  totalErrors: number;
  totalWarnings: number;
}

export async function runValidation(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  documentType: DocumentType
): Promise<ValidationOutput> {
  const checks: ValidationCheck[] = [];

  if (documentType === 'invoice' || documentType === 'receipt') {
    await validateInvoice(supabase, documentId, checks);
  } else if (documentType === 'order') {
    await validateOrder(supabase, documentId, checks);
  } else {
    checks.push({
      check_type: 'completeness',
      check_name: 'document_type_unknown',
      passed: false,
      severity: 'error',
      message: `Unrecognized document type: ${documentType}`,
    });
  }

  const errors = checks.filter((c) => !c.passed && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.passed && c.severity === 'warning').length;
  // Only HARD errors should fail validation. Warnings are surfaced in the
  // UI but must not prevent the row from showing up in the data table.
  const allPassed = errors === 0;

  // Determine exception priority if failed
  if (!allPassed) {
    const priority = errors > 3 ? 'critical' : errors > 1 ? 'high' : errors === 1 ? 'medium' : 'low';
    const reason = checks
      .filter((c) => !c.passed)
      .map((c) => c.message)
      .join('; ');

    // Write validation + exception data to invoice or order
    const table = (documentType === 'invoice' || documentType === 'receipt') ? 'invoices' : 'orders';
    await supabase
      .from(table)
      .update({
        validation_status: 'failed',
        validation_checks: checks as any,
        validation_errors: errors,
        validation_warnings: warnings,
        exception_status: 'pending',
        exception_priority: priority,
        exception_reason: reason,
      } as any)
      .eq('document_id', documentId);
  } else {
    const table = (documentType === 'invoice' || documentType === 'receipt') ? 'invoices' : 'orders';
    await supabase
      .from(table)
      .update({
        validation_status: 'passed',
        validation_checks: checks as any,
        validation_errors: 0,
        validation_warnings: warnings,
      } as any)
      .eq('document_id', documentId);
  }

  return { allPassed, totalChecks: checks.length, totalErrors: errors, totalWarnings: warnings };
}

// ────────── Invoice validation ──────────

async function validateInvoice(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  checks: ValidationCheck[]
) {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('*, invoice_lines(*)')
    .eq('document_id', documentId)
    .single();

  if (!invoice) {
    checks.push({
      check_type: 'completeness',
      check_name: 'invoice_record_missing',
      passed: false,
      severity: 'error',
      message: 'No invoice record found for this document',
    });
    return;
  }

  // ── Completeness ──
  // Critical fields (error if missing)
  const critical: [string, unknown][] = [
    ['invoice_number', invoice.invoice_number],
    ['total_amount', invoice.total_amount],
  ];

  for (const [field, value] of critical) {
    checks.push({
      check_type: 'completeness',
      check_name: `required_${field}`,
      passed: value != null && String(value).trim() !== '',
      severity: 'error',
      message: value ? `${field} is present` : `Required field "${field}" is missing`,
      field_name: field,
      actual_value: value != null ? String(value) : 'null',
    });
  }

  // Important fields (warning if missing — OCR may not always extract these)
  const important: [string, unknown][] = [
    ['invoice_date', invoice.invoice_date],
    ['vendor_name', invoice.vendor_name],
  ];

  for (const [field, value] of important) {
    checks.push({
      check_type: 'completeness',
      check_name: `recommended_${field}`,
      passed: value != null && String(value).trim() !== '',
      severity: 'warning',
      message: value ? `${field} is present` : `Recommended field "${field}" is missing`,
      field_name: field,
      actual_value: value != null ? String(value) : 'null',
    });
  }

  // ── Date validation ──
  if (invoice.invoice_date) {
    const d = new Date(invoice.invoice_date);
    const isFuture = d > new Date();
    checks.push({
      check_type: 'date_check',
      check_name: 'invoice_date_not_future',
      passed: !isFuture,
      severity: 'warning',
      message: isFuture ? `Invoice date ${invoice.invoice_date} is in the future` : 'Invoice date is valid',
      field_name: 'invoice_date',
      actual_value: invoice.invoice_date,
    });
  }

  // ── Line items math ──
  const lineItems = (invoice as any).invoice_lines as Array<{
    id: string; quantity: number | null; unit_price: number | null; line_total: number | null; sku_code: string | null;
  }> | undefined;

  if (lineItems && lineItems.length > 0) {
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (li.quantity != null && li.unit_price != null && li.line_total != null) {
        const expected = Math.round(li.quantity * li.unit_price * 100) / 100;
        const actual = Math.round(li.line_total * 100) / 100;
        const diff = Math.abs(expected - actual);
        const pass = diff < 0.02;
        checks.push({
          check_type: 'math_check',
          check_name: `line_${i + 1}_math`,
          passed: pass,
          severity: 'error',
          message: pass
            ? `Line ${i + 1}: Qty × Price = Total ✓`
            : `Line ${i + 1}: Qty(${li.quantity}) × Price(${li.unit_price}) = ${expected}, but total is ${actual}`,
          field_name: `line_${i + 1}.line_total`,
          expected_value: String(expected),
          actual_value: String(actual),
        });

        // Update math_valid on line
        await supabase.from('invoice_lines').update({ math_valid: pass } as any).eq('id', li.id);
      }
    }

    // ── Subtotal check ──
    if (invoice.subtotal != null) {
      const lineSum = lineItems.reduce((s, li) => s + (li.line_total ?? 0), 0);
      const diff = Math.abs(lineSum - (invoice.subtotal as number));
      checks.push({
        check_type: 'total_check',
        check_name: 'subtotal_matches_lines',
        passed: diff < 0.1,
        severity: 'error',
        message: diff < 0.1
          ? 'Subtotal matches sum of line items'
          : `Sum of lines ($${lineSum.toFixed(2)}) ≠ subtotal ($${(invoice.subtotal as number).toFixed(2)})`,
        field_name: 'subtotal',
        expected_value: String(lineSum.toFixed(2)),
        actual_value: String((invoice.subtotal as number).toFixed(2)),
      });
    }

    // ── Total = subtotal + tax check ──
    if (invoice.subtotal != null && invoice.total_amount != null) {
      const expectedTotal = (invoice.subtotal as number) + ((invoice.tax_amount as number) ?? 0);
      const diff = Math.abs(expectedTotal - (invoice.total_amount as number));
      checks.push({
        check_type: 'total_check',
        check_name: 'total_equals_subtotal_plus_tax',
        passed: diff < 0.1,
        severity: 'error',
        message: diff < 0.1
          ? 'Total = Subtotal + Tax ✓'
          : `Subtotal + Tax ≠ Total`,
        field_name: 'total_amount',
        expected_value: String(expectedTotal.toFixed(2)),
        actual_value: String((invoice.total_amount as number).toFixed(2)),
      });
    }
  }

  // ── Duplicate detection ──
  if (invoice.invoice_number && invoice.vendor_name) {
    const { data: dups } = await supabase
      .from('invoices')
      .select('id')
      .eq('invoice_number', invoice.invoice_number)
      .eq('vendor_name', invoice.vendor_name)
      .neq('document_id', documentId)
      .limit(1);

    const isDup = dups && dups.length > 0;
    checks.push({
      check_type: 'duplicate_check',
      check_name: 'duplicate_invoice',
      passed: !isDup,
      severity: isDup ? 'error' : 'info',
      message: isDup
        ? `Duplicate invoice: ${invoice.invoice_number} from ${invoice.vendor_name}`
        : 'No duplicate found',
      field_name: 'invoice_number',
      actual_value: invoice.invoice_number,
    });

    if (isDup) {
      await supabase.from('invoices').update({ is_duplicate: true } as any).eq('id', invoice.id);
    }
  }
}

// ────────── Order validation ──────────

async function validateOrder(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  checks: ValidationCheck[]
) {
  const { data: order } = await supabase
    .from('orders')
    .select('*, order_lines(*)')
    .eq('document_id', documentId)
    .single();

  if (!order) {
    checks.push({
      check_type: 'completeness',
      check_name: 'order_record_missing',
      passed: false,
      severity: 'error',
      message: 'No order record found for this document',
    });
    return;
  }

  // ── Completeness ──
  // Only order_number is a hard requirement (the pipeline derives one from
  // the document's filename when the page itself doesn't have one). Missing
  // customer_name / order_date are flagged as WARNINGS rather than errors
  // so handwritten / WhatsApp-style orders (which often omit these fields)
  // still pass into the data table for review instead of being hidden
  // behind an exception badge with no visible row.
  const required: [string, unknown][] = [
    ['order_number', order.order_number],
  ];
  const recommended: [string, unknown][] = [
    ['order_date', order.order_date],
    ['customer_name', order.customer_name],
  ];

  for (const [field, value] of required) {
    checks.push({
      check_type: 'completeness',
      check_name: `required_${field}`,
      passed: value != null && String(value).trim() !== '',
      severity: 'error',
      message: value ? `${field} is present` : `Required field "${field}" is missing`,
      field_name: field,
      actual_value: value != null ? String(value) : 'null',
    });
  }

  for (const [field, value] of recommended) {
    const present = value != null && String(value).trim() !== '';
    checks.push({
      check_type: 'completeness',
      check_name: `recommended_${field}`,
      passed: present,
      severity: 'warning',
      message: present ? `${field} is present` : `Recommended field "${field}" is missing`,
      field_name: field,
      actual_value: value != null ? String(value) : 'null',
    });
  }

  // ── Date validation ──
  if (order.order_date) {
    const d = new Date(order.order_date);
    const isFuture = d > new Date();
    checks.push({
      check_type: 'date_check',
      check_name: 'order_date_not_future',
      passed: !isFuture,
      severity: 'warning',
      message: isFuture ? 'Order date is in the future' : 'Order date is valid',
      field_name: 'order_date',
      actual_value: order.order_date,
    });
  }

  // ── Line items ──
  const lineItems = (order as any).order_lines as Array<{
    quantity: number | null; unit_price: number | null; line_total: number | null; sku_code: string | null;
  }> | undefined;

  if (lineItems && lineItems.length > 0) {
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      if (li.quantity != null && li.unit_price != null && li.line_total != null) {
        const expected = Math.round(li.quantity * li.unit_price * 100) / 100;
        const diff = Math.abs(expected - li.line_total);
        checks.push({
          check_type: 'math_check',
          check_name: `order_line_${i + 1}_math`,
          passed: diff < 0.02,
          severity: diff < 0.02 ? 'info' : 'error',
          message: diff < 0.02 ? `Line ${i + 1}: Qty × Price = Total ✓` : `Line ${i + 1}: calculation mismatch`,
          field_name: `line_${i + 1}.line_total`,
          expected_value: String(expected),
          actual_value: String(li.line_total),
        });
      }

      if (li.quantity != null) {
        const valid = li.quantity > 0 && li.quantity < 100000;
        checks.push({
          check_type: 'range_check',
          check_name: `order_line_${i + 1}_qty_range`,
          passed: valid,
          severity: 'warning',
          message: valid ? `Line ${i + 1}: quantity in range` : `Line ${i + 1}: quantity ${li.quantity} outside expected range`,
          field_name: `line_${i + 1}.quantity`,
          actual_value: String(li.quantity),
        });
      }
    }
  }

  // ── Duplicate detection ──
  if (order.order_number && order.customer_name) {
    const { data: dups } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', order.order_number)
      .eq('customer_name', order.customer_name)
      .neq('document_id', documentId)
      .limit(1);

    const isDup = dups && dups.length > 0;
    checks.push({
      check_type: 'duplicate_check',
      check_name: 'duplicate_order',
      passed: !isDup,
      severity: isDup ? 'error' : 'info',
      message: isDup
        ? `Duplicate order: ${order.order_number} from ${order.customer_name}`
        : 'No duplicate found',
      field_name: 'order_number',
      actual_value: order.order_number,
    });

    if (isDup) {
      await supabase.from('orders').update({ is_duplicate: true } as any).eq('id', order.id);
    }
  }
}

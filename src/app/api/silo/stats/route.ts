import { NextResponse } from 'next/server';
import { siloGraphQL, fetchCustomers, fetchVendors, fetchProducts } from '@/lib/silo/client';
import { createServiceRoleClient } from '@/lib/supabase/server';

interface StatsResponse {
  salesOrders: { totalCount: number };
  purchaseOrders: { totalCount: number };
  payments: { totalCount: number };
}

interface RecentSalesResponse {
  salesOrders: {
    edges: {
      node: {
        id: string;
        invoiceNumber: string | null;
        requestedDate: string;
        orderTotal: number;
        paymentStatus: string;
        customer: { companyName: string };
      };
    }[];
  };
}

interface RecentPaymentsResponse {
  payments: {
    edges: {
      node: {
        id: string;
        amount: number;
        paymentDate: string;
        paymentMethod: string | null;
        isRefund: boolean;
        customer: { companyName: string } | null;
        vendor: { companyName: string } | null;
      };
    }[];
  };
}

export async function GET() {
  try {
    const supabase = createServiceRoleClient();

    const [stats, recentSales, recentPayments, customerData, vendorData, productResult] = await Promise.all([
      // Counts
      siloGraphQL<StatsResponse>(`{
        salesOrders(first: 1) { totalCount }
        purchaseOrders(first: 1) { totalCount }
        payments(first: 1) { totalCount }
      }`),
      // Recent 5 sales orders
      siloGraphQL<RecentSalesResponse>(`{
        salesOrders(first: 5, orderBy: [{ field: REQUESTED_DATE, direction: DESC }]) {
          edges {
            node {
              id invoiceNumber requestedDate orderTotal paymentStatus
              customer { companyName }
            }
          }
        }
      }`),
      // Recent 5 payments
      siloGraphQL<RecentPaymentsResponse>(`{
        payments(first: 5) {
          edges {
            node {
              id amount paymentDate paymentMethod isRefund
              customer { companyName }
              vendor { companyName }
            }
          }
        }
      }`),
      // All unique customers
      fetchCustomers(500),
      // All unique vendors
      fetchVendors(500),
      // All unique products (inventory items) — graceful fallback on error
      fetchProducts(200).catch(err => {
        console.warn('fetchProducts failed, using fallback:', err instanceof Error ? err.message : err);
        return { products: [], totalOrders: 0, pageInfo: { hasNextPage: false, endCursor: null } };
      }),
    ]);
    const productData = productResult;

    // Count new invoices & orders from non-Silo sources
    const newSources = ['whatsapp', 'email', 'scanner', 'google_drive', 'cloud_upload'];

    const { data: newDocIds } = await supabase
      .from('documents')
      .select('id')
      .in('source', newSources);

    const docIds = (newDocIds || []).map(d => d.id);

    let newInvoiceCount = 0;
    let newOrderCount = 0;

    if (docIds.length > 0) {
      const [invResult, ordResult] = await Promise.all([
        supabase.from('invoices').select('id', { count: 'exact', head: true }).in('document_id', docIds),
        supabase.from('orders').select('id', { count: 'exact', head: true }).in('document_id', docIds),
      ]);
      newInvoiceCount = invResult.count ?? 0;
      newOrderCount = ordResult.count ?? 0;
    }

    return NextResponse.json({
      counts: {
        salesOrders: stats.salesOrders.totalCount,
        purchaseOrders: stats.purchaseOrders.totalCount,
        payments: stats.payments.totalCount,
        customers: customerData.customers.length,
        vendors: vendorData.vendors.length,
        inventoryItems: productData.products?.length ?? 0,
        newInvoices: newInvoiceCount,
        newOrders: newOrderCount,
      },
      recentSalesOrders: recentSales.salesOrders.edges.map(e => e.node),
      recentPayments: recentPayments.payments.edges.map(e => e.node),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Silo stats error:', message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

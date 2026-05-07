-- ============================================================
-- Supabase Migration: Row Level Security (RLS) Policies
-- RBAC: admin, reviewer, read_only (SRS 4.5.2)
-- ============================================================

-- ============================================================
-- HELPER FUNCTION: get current user's role
-- ============================================================

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS user_role AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_reviewer_or_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin', 'reviewer'));
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_skus ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_preprocessed ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_ocr_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE silo_export_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- USER PROFILES
-- ============================================================

-- Everyone can read their own profile
CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  USING (id = auth.uid());

-- Admin can view all profiles
CREATE POLICY "Admin can view all profiles"
  ON user_profiles FOR SELECT
  USING (is_admin());

-- Admin can manage profiles
CREATE POLICY "Admin can insert profiles"
  ON user_profiles FOR INSERT
  WITH CHECK (is_admin());

CREATE POLICY "Admin can update profiles"
  ON user_profiles FOR UPDATE
  USING (is_admin());

-- ============================================================
-- MASTER DATA: All roles can read, only admin can write
-- ============================================================

-- master_skus
CREATE POLICY "All authenticated can read SKUs"
  ON master_skus FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage SKUs"
  ON master_skus FOR ALL
  USING (is_admin());

-- master_customers
CREATE POLICY "All authenticated can read customers"
  ON master_customers FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage customers"
  ON master_customers FOR ALL
  USING (is_admin());

-- master_vendors
CREATE POLICY "All authenticated can read vendors"
  ON master_vendors FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage vendors"
  ON master_vendors FOR ALL
  USING (is_admin());

-- vendor_templates
CREATE POLICY "All authenticated can read templates"
  ON vendor_templates FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage templates"
  ON vendor_templates FOR ALL
  USING (is_admin());

-- ============================================================
-- DOCUMENTS: All can read, admin can write
-- ============================================================

CREATE POLICY "All authenticated can read documents"
  ON documents FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage documents"
  ON documents FOR ALL
  USING (is_admin());

-- document_preprocessed
CREATE POLICY "All authenticated can read preprocessed"
  ON document_preprocessed FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage preprocessed"
  ON document_preprocessed FOR ALL
  USING (is_admin());

-- document_ocr_results
CREATE POLICY "All authenticated can read OCR results"
  ON document_ocr_results FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage OCR results"
  ON document_ocr_results FOR ALL
  USING (is_admin());

-- ============================================================
-- INVOICES & ORDERS: All read, reviewer+admin can update
-- ============================================================

-- invoices
CREATE POLICY "All authenticated can read invoices"
  ON invoices FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can update invoices"
  ON invoices FOR UPDATE
  USING (is_reviewer_or_admin());

CREATE POLICY "Admin can insert invoices"
  ON invoices FOR INSERT
  WITH CHECK (is_admin());

-- invoice_line_items
CREATE POLICY "All authenticated can read invoice lines"
  ON invoice_line_items FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can update invoice lines"
  ON invoice_line_items FOR UPDATE
  USING (is_reviewer_or_admin());

CREATE POLICY "Admin can insert invoice lines"
  ON invoice_line_items FOR INSERT
  WITH CHECK (is_admin());

-- orders
CREATE POLICY "All authenticated can read orders"
  ON orders FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can update orders"
  ON orders FOR UPDATE
  USING (is_reviewer_or_admin());

CREATE POLICY "Admin can insert orders"
  ON orders FOR INSERT
  WITH CHECK (is_admin());

-- order_line_items
CREATE POLICY "All authenticated can read order lines"
  ON order_line_items FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can update order lines"
  ON order_line_items FOR UPDATE
  USING (is_reviewer_or_admin());

CREATE POLICY "Admin can insert order lines"
  ON order_line_items FOR INSERT
  WITH CHECK (is_admin());

-- ============================================================
-- VALIDATION RESULTS: All read, admin write
-- ============================================================

CREATE POLICY "All authenticated can read validation"
  ON validation_results FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage validation"
  ON validation_results FOR ALL
  USING (is_admin());

-- ============================================================
-- EXCEPTIONS: All read, reviewer+admin can manage
-- ============================================================

CREATE POLICY "All authenticated can read exceptions"
  ON exceptions FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can update exceptions"
  ON exceptions FOR UPDATE
  USING (is_reviewer_or_admin());

CREATE POLICY "Admin can insert exceptions"
  ON exceptions FOR INSERT
  WITH CHECK (is_admin());

-- exception_comments
CREATE POLICY "All authenticated can read comments"
  ON exception_comments FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Reviewer or admin can add comments"
  ON exception_comments FOR INSERT
  WITH CHECK (is_reviewer_or_admin());

-- ============================================================
-- SILO EXPORTS: All read, admin manage
-- ============================================================

CREATE POLICY "All authenticated can read exports"
  ON silo_exports FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage exports"
  ON silo_exports FOR ALL
  USING (is_admin());

CREATE POLICY "All authenticated can read export items"
  ON silo_export_items FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage export items"
  ON silo_export_items FOR ALL
  USING (is_admin());

-- ============================================================
-- LOGS & AUDIT: All read, system writes (via service role)
-- ============================================================

CREATE POLICY "All authenticated can read processing logs"
  ON processing_logs FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage processing logs"
  ON processing_logs FOR ALL
  USING (is_admin());

CREATE POLICY "All authenticated can read audit logs"
  ON audit_logs FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage audit logs"
  ON audit_logs FOR ALL
  USING (is_admin());

-- daily_summaries
CREATE POLICY "All authenticated can read summaries"
  ON daily_summaries FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can manage summaries"
  ON daily_summaries FOR ALL
  USING (is_admin());

-- ============================================================
-- NOTIFICATIONS: Users see own, admin sees all
-- ============================================================

CREATE POLICY "Users can read own notifications"
  ON notifications FOR SELECT
  USING (recipient_user_id = auth.uid());

CREATE POLICY "Admin can read all notifications"
  ON notifications FOR SELECT
  USING (is_admin());

CREATE POLICY "Admin can manage notifications"
  ON notifications FOR ALL
  USING (is_admin());

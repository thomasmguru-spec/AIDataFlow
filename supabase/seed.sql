-- ============================================================
-- Seed Data: Sample master data for testing
-- Run after migrations, NOT in production without review
-- ============================================================

-- ============================================================
-- SAMPLE SKU MASTER DATA
-- ============================================================

INSERT INTO master_skus (item_code, description, unit_price, unit_of_measure, category) VALUES
  ('SKU-001', 'Organic Bananas (bunch)', 2.99, 'bunch', 'Produce'),
  ('SKU-002', 'Red Apples (lb)', 3.49, 'lb', 'Produce'),
  ('SKU-003', 'Whole Milk 1 Gallon', 4.29, 'gallon', 'Dairy'),
  ('SKU-004', 'White Bread Loaf', 2.49, 'loaf', 'Bakery'),
  ('SKU-005', 'Chicken Breast (lb)', 6.99, 'lb', 'Meat'),
  ('SKU-006', 'Brown Rice 5lb Bag', 7.99, 'bag', 'Grains'),
  ('SKU-007', 'Olive Oil Extra Virgin 500ml', 8.49, 'bottle', 'Pantry'),
  ('SKU-008', 'Eggs Large Dozen', 3.99, 'dozen', 'Dairy'),
  ('SKU-009', 'Tomato Sauce 24oz', 2.29, 'can', 'Pantry'),
  ('SKU-010', 'Frozen Mixed Vegetables 16oz', 3.19, 'bag', 'Frozen');

-- ============================================================
-- SAMPLE CUSTOMER MASTER DATA
-- ============================================================

INSERT INTO master_customers (customer_code, customer_name, phone, whatsapp_number, email, billing_address, shipping_address) VALUES
  ('CUST-001', 'Fresh Foods Market', '+1-555-0101', '+15550101', 'orders@freshfoods.com', '123 Market St, NY 10001', '123 Market St, NY 10001'),
  ('CUST-002', 'Green Grocery Store', '+1-555-0102', '+15550102', 'purchasing@greengrocery.com', '456 Oak Ave, CA 90210', '456 Oak Ave, CA 90210'),
  ('CUST-003', 'Daily Essentials Inc', '+1-555-0103', '+15550103', 'orders@dailyessentials.com', '789 Main Blvd, TX 75001', '789 Main Blvd, TX 75001'),
  ('CUST-004', 'Corner Shop LLC', '+1-555-0104', '+15550104', 'info@cornershop.com', '321 Pine Rd, FL 33101', '321 Pine Rd, FL 33101'),
  ('CUST-005', 'Metro Supermart', '+1-555-0105', '+15550105', 'supply@metrosuper.com', '654 Elm St, IL 60601', '654 Elm St, IL 60601');

-- ============================================================
-- SAMPLE VENDOR MASTER DATA
-- ============================================================

INSERT INTO master_vendors (vendor_code, vendor_name, email, phone, address) VALUES
  ('VND-001', 'Pacific Coast Produce', 'sales@pacificproduce.com', '+1-555-0201', '100 Harbor Dr, CA 90731'),
  ('VND-002', 'Heartland Dairy Farms', 'orders@heartlanddairy.com', '+1-555-0202', '200 Farm Rd, WI 53001'),
  ('VND-003', 'National Bakery Supply', 'wholesale@nationalbakery.com', '+1-555-0203', '300 Wheat St, KS 66001'),
  ('VND-004', 'Premium Meat Distributors', 'supply@premiummeat.com', '+1-555-0204', '400 Ranch Blvd, TX 76001'),
  ('VND-005', 'Global Pantry Imports', 'orders@globalpantry.com', '+1-555-0205', '500 Trade Ave, NJ 07001');

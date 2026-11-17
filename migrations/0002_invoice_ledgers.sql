-- Normalized invoice, debtor and creditor ledgers.
-- Existing JSON ledger data remains untouched and continues to power legacy workflows.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('customer','supplier')),
  name TEXT NOT NULL COLLATE NOCASE,
  address TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  state_code TEXT NOT NULL DEFAULT '',
  place_of_supply TEXT NOT NULL DEFAULT '',
  opening_balance_paise INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, name)
);

CREATE TABLE IF NOT EXISTS item_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE,
  description TEXT NOT NULL,
  default_rate_paise_per_kg INTEGER CHECK (default_rate_paise_per_kg IS NULL OR default_rate_paise_per_kg >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  party_id TEXT NOT NULL REFERENCES parties(id),
  invoice_date TEXT NOT NULL,
  due_date TEXT,
  place_of_supply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','partially_paid','paid','corrected','void')),
  tax_mode TEXT NOT NULL DEFAULT 'none' CHECK (tax_mode IN ('none','manual')),
  transportation_paise INTEGER NOT NULL DEFAULT 0 CHECK (transportation_paise >= 0),
  subtotal_paise INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paise >= 0),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise INTEGER NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  description TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT 'Thanks for doing business with us!',
  legacy_sale_id TEXT UNIQUE,
  correction_of_invoice_id TEXT REFERENCES invoices(id),
  version INTEGER NOT NULL DEFAULT 1,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  quantity_grams INTEGER NOT NULL CHECK (quantity_grams > 0),
  rate_paise_per_kg INTEGER NOT NULL CHECK (rate_paise_per_kg >= 0),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  UNIQUE(invoice_id, position)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('received','made')),
  party_id TEXT NOT NULL REFERENCES parties(id),
  payment_date TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('invoice','purchase','opening_balance')),
  target_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(payment_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS ledger_adjustments (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES parties(id),
  direction TEXT NOT NULL CHECK (direction IN ('receivable_credit','payable_credit')),
  adjustment_date TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS financial_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_party_date ON invoices(party_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_party_date ON payments(party_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_allocations_target ON payment_allocations(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_events_sequence ON financial_events(sequence);

INSERT OR IGNORE INTO app_config (key, value) VALUES
('seller', '{"name":"AXE CAP LOGISTICS LLP","address":"H. No-RZG-34, Kh No-22/23, 24, 22/18, Laxmi Park, Nangloi, New Delhi, West Delhi - 110041, Delhi, India","pan":"ACPFA7756A","tan":"DELA90891D","llpin":"ADB-5913","state":"07-Delhi"}'),
('invoice', '{"heading":"Tax Invoice","prefix":"2026","nextSequence":2009,"taxMode":"none","terms":"Thanks for doing business with us!","authorisedSignatory":"Authorised Signatory"}');

INSERT OR IGNORE INTO parties
  (id, type, name, address, tax_id, state_code, place_of_supply, opening_balance_paise)
VALUES
  ('customer-aeom-india-llp','customer','AEOM INDIA LLP','Shop No 13, Madhav Avenue, Moti Khavadi, Sikka, Jamnagar, Gujarat - 361140','24ACIFA1248E1ZU','24-Gujarat','24-Gujarat',0);

INSERT OR IGNORE INTO item_codes (code, description, default_rate_paise_per_kg) VALUES
  ('SAR','Fish Food SAR',20000),
  ('SQD','Squid',57500),
  ('SPR','Sprat',21000),
  ('MUL','Mullet',23000),
  ('MAC','Mackrel',23000),
  ('TRT','Trout',NULL);

-- Make existing suppliers available in the creditor ledger without changing legacy purchases.
INSERT OR IGNORE INTO parties (id, type, name)
SELECT 'supplier-' || lower(hex(randomblob(8))), 'supplier', supplier
FROM (
  SELECT DISTINCT trim(json_extract(j.value, '$.supplier')) AS supplier
  FROM ledger l, json_each(l.data, '$.purchases') j
  WHERE trim(json_extract(j.value, '$.supplier')) <> ''
);

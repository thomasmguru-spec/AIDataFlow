-- Add 'google_drive' to document_source enum
ALTER TYPE document_source ADD VALUE IF NOT EXISTS 'google_drive';

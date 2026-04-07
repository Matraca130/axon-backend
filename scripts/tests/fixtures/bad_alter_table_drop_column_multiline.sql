-- Multi-line bypass attempt — must still be detected.
ALTER TABLE
  public.users
  DROP COLUMN legacy_field;

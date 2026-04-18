-- This is a line comment that says: DROP TABLE foo
-- We want to be able to write that without tripping the scanner.

/*
  This is a block comment.
  It also says DROP TABLE bar in here.
  And ALTER TABLE baz DROP COLUMN qux for good measure.
*/

CREATE TABLE IF NOT EXISTS public.thing (id UUID PRIMARY KEY);

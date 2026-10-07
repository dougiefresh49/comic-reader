-- bubbles.fill_color (#575): the balloon's fill colour, sampled from the page
-- image under the bubble's box, as lowercase #rrggbb. The reader picks the
-- word-highlight colour from it (src/lib/highlight-color.ts), so words on a
-- coloured balloon light in a colour that stands out against it. Null means
-- not sampled yet, or the sample found too little fill to trust, and the
-- reader falls back to the default yellow marker.
--
-- Additive only: one nullable column, so every existing row reads as not
-- sampled. The table's RLS and grants are unchanged.

alter table bubbles
  add column fill_color text
  check (fill_color ~ '^#[0-9a-f]{6}$');

comment on column bubbles.fill_color is
  'Balloon fill colour under the bubble box, lowercase #rrggbb, sampled from the page image (#575). Null: not sampled, or too little fill to tell.';

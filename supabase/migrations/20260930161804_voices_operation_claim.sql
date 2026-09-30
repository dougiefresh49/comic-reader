alter table voices
  add column operation_claim text,
  add column operation_claimed_at timestamptz;

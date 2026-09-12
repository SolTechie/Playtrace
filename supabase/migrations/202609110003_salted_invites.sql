-- Existing invitations without a salt remain unusable until explicitly reissued/rehash.
alter table public.management_invites add column salt text
  check (salt ~ '^[a-f0-9]{32}$');
comment on column public.management_invites.salt is
  'Random 16-byte salt, hex encoded. code_hash is PBKDF2-SHA256, 100000 iterations, 32 bytes.';

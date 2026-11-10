# License public keys

The distributable verification key is `license-public.pem` and is intentionally
committed so every self-hosted instance can validate offline licenses.

Never place a private signing key, issued customer key, or customer agreement in
this directory or a container image. Those files belong in protected contract
storage; temporary installation copies use the ignored `deploy/migration/` area.

# Security

## Reporting a vulnerability

Please report it privately through GitHub's
[private vulnerability reporting](https://github.com/ManasMadan/boilerplate/security/advisories/new),
never in a public issue or pull request. Include what's affected, how to reproduce it,
and the impact you expect.

You'll get an acknowledgement within three working days and an assessment within ten.
Fixes go out on master and in the next release; you'll be credited in the advisory
unless you'd rather not be.

## Supported versions

Only the latest release and master get security fixes.

## What's already in place

Every change is scanned for leaked secrets (gitleaks), vulnerable or disallowed-license
dependencies (dependency review, OSV) and code issues (CodeQL); images are scanned by
Trivy, signed with cosign and shipped with provenance attestations and an SBOM per
platform. Tenant data is isolated by forced row-level security, and each service
connects as its own least-privileged database role.

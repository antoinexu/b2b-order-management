# Security Policy

## Supported versions

Security fixes are made on the `main` branch and included in the next release. Only the latest release is supported.

## Reporting a vulnerability

Please **do not** report security vulnerabilities in public issues, discussions or pull requests.

Report them privately through GitHub:
[**Report a vulnerability**](https://github.com/antoinexu/b2b-order-management/security/advisories/new).

Please include:

- the affected endpoint, page or file, and the version or commit
- steps to reproduce, or a proof of concept
- the impact you believe it has (for example, cross-tenant data access or privilege escalation)

## What to expect

- We acknowledge reports within 3 business days.
- We aim to confirm the issue and share a fix plan within 10 business days.
- We will credit you in the advisory and changelog, unless you prefer to stay anonymous.
- Please give us a reasonable time to release a fix before disclosing the issue publicly.

## Scope

Especially relevant to this project:

- tenant isolation (reading or changing another organization's data)
- authentication, JWT handling, token revocation, password reset and invitation links
- role-based permissions and the sales discount limit
- the unauthenticated customer quote links (`/public/quotes/*`)
- injection, and leaking secrets or credentials in logs

Out of scope: denial of service through traffic volume, issues that need a compromised server or database, and
reports from automated scanners without a demonstrated impact.

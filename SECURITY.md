# Security

Please don't open a public issue for a vulnerability. Report it privately through GitHub's
**Security → Report a vulnerability** on this repository. Include steps to reproduce and the
impact you expect.

We'll acknowledge the report, keep you posted while we fix it, and credit you if you'd like.

Areas we especially care about:

- workspace isolation
- role checks
- the LLM proxy and job tokens (sandboxes must never see real credentials)
- encrypted credential storage
- share links

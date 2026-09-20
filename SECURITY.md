# Security

Opifer runs on one machine for one team and, in version 1.0, has no authentication: the server listens on `127.0.0.1` and whoever reaches the port is the owner. What is protected and how, and what is not done yet, is in [docs/security.md](docs/security.md). Read it before exposing anything.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

- Preferred: [report it privately on GitHub](https://github.com/NextEpochs/opifer/security/advisories/new). Only the maintainers see it.
- Otherwise: email the maintainer at the address on the commits of this repository, with `[opifer security]` in the subject.

You will get an answer within five working days. Once the fix is out, the report is credited in the release notes unless you prefer not to be named.

## What counts

Anything that lets a person or an agent do more than the governance allows: read a secret's value, run a tool the policy blocks or without the approval it needs, spend past a cap, act on another company's data, forge a webhook call or an outbound event, escape the sandbox. Bugs in the interface that do not cross those lines are ordinary issues.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| 0.1.x   | No: upgrade to 1.0 |

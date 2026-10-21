# Security Policy

This document describes how to report security vulnerabilities in this project and what to expect in response.

This bot handles sensitive material, including a Telegram bot token, chat IDs, and an optional webhook secret. Please do not report suspected security issues in public GitHub issues, pull requests, or discussions.

## Supported Versions

Only the latest code on the `main` branch is supported with security fixes. Older commits, forks, and release branches are not supported.

| Version         | Supported          |
| ---------------- | ----------------- |
| Latest `main`   | :white_check_mark: |
| Anything else    | :x:                |

## Reporting a Vulnerability

Please report vulnerabilities privately using GitHub Security Advisories:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Provide a description of the issue, steps to reproduce it, affected components, and any suggested mitigation.

Do not include real bot tokens, chat IDs, webhook secrets, or other credentials in your report. Redact or rotate them before sharing any logs or configuration snippets.

## What to Expect

Response steps for a reported vulnerability:

1. **Acknowledgement** — we aim to acknowledge your report within a few business days.
2. **Triage** — we review the report, confirm scope and impact, and ask follow-up questions if needed.
3. **Fix** — we prepare a fix on a private branch and coordinate disclosure timing with you.
4. **Disclosure** — we publish an advisory and release the fix on `main`.
5. **Credit** — we are happy to credit reporters in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- **Token leakage** — exposure of the Telegram bot token, webhook secret, or other credentials through logs, error messages, output, commits, or redaction bypasses (see `src/redact.ts` and `src/logger.ts`).
- **Command authorization** — any way to invoke bot commands without the required authorization, including chat ID or admin check bypasses.
- **Webhook handling** — forgery, replay, signature verification failures, or other issues that let an attacker impersonate Telegram or trigger unauthorized actions.

Out of scope:

- Vulnerabilities in the Telegram platform or Telegram clients.
- Vulnerabilities in the Stellar platform, SDKs, or network.
- Issues requiring privileged operator access to the deployment environment that are not caused by this codebase.
- Social engineering, phishing, or deny-of-service against third-party services.

## Guidelines

- Act in good faith and avoid privacy violations, service disruption, or data destruction.
- Only test against your own instances and configuration.
- Do not access data that does not belong to you.
- Give us a reasonable opportunity to fix the issue before public disclosure.

Thank you for helping keep this project and its users safe.

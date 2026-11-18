# Security overview

SB Content Intelligence is an internal Succulents Box tool. The repository is public; the data, prompts and brand rules are not.

- **Access.** Team members sign in with Google. New accounts wait for approval by an owner or admin, and roles decide what each member can change.
- **Data.** The database limits every table to approved members, and the public key in the page grants nothing on its own. Prompts, brand rules and integration settings live in private, server-only records.
- **Server actions.** AI analysis, sheet writes and imports run in server functions that check the session and role first. Scheduled jobs and integrations each use their own credential, limited to their own task.
- **Product data.** The product seed in this repository contains public catalog fields only.

Configuration and operator procedures are kept privately. Report a security concern to the repository owner privately rather than in a public issue.

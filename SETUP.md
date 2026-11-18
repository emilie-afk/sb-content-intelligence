# SB Content Intelligence

SB Content Intelligence is the Succulents Box team's social-listening and script-production workspace. It collects content signals from social platforms and team submissions, groups them into themes, and helps the team turn the best ideas into scripts and briefs. It also tracks how published videos perform.

This repository is public and contains code only. Sheet locations, credentials, member lists, prompts, brand rules and operator procedures live in private configuration. They are not part of this repository.

## Parts

- **Dashboard:** a web page where team members sign in with Google. New accounts wait for approval.
- **Server functions:** every endpoint checks its caller before doing any work.
- **Database:** row-level security limits data to approved members.
- **Scheduled jobs and sheet integrations:** each one uses its own private credential.

## Development

Requires Node.js 22. `npm test` runs the unit and integration suites with synthetic data.

Security overview: [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

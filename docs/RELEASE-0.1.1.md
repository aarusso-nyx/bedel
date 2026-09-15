# Bedel 0.1.1

Fixes executable startup when npm exposes `bedel` through a symlink. Version 0.1.0 could exit silently through `node_modules/.bin/bedel`; its package and tag are preserved for history and superseded by this release.

Install `bedel-0.1.1.tgz` with `npm install -g ./bedel-0.1.1.tgz`. The exact packed executable was installed in a path containing spaces and non-ASCII characters and exercised through `.bin/bedel` with `--version`, `--help` and a real Docker-backed planning command. No mutants are executed by these installation checks.

All portable mutation hardening features and bounded qualification described in `docs/QUALIFICATION.md` remain available. This release changes entrypoint resolution only; no full mutation campaign or package-registry publication was performed.

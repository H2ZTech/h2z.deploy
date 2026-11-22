# h2z.deploy

H2Z security deployment files. This public repo is the single home of the B line: change it here and push to main.

On a fresh Debian / Ubuntu machine (x86_64 or arm64), one command installs everything:

```bash
curl -fsSL https://raw.githubusercontent.com/H2ZTech/h2z.deploy/main/install.sh | sudo sh
```

To only see what it would do: `... | sudo sh -s -- --dry-run`. Details: docs/DEPLOY-B-LINE.md.
All images come from GHCR (ghcr.io/h2ztech/, public, no login).

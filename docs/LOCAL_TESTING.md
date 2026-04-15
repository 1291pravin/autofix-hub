# Local Testing (without publishing to npm)

How to test autofix-hub packages on another machine without publishing to the public npm registry.

## Option 1: Verdaccio (recommended)

[Verdaccio](https://verdaccio.org/) is a lightweight local npm registry. It fully simulates npm publish/install — `workspace:*` dependencies resolve correctly and the other machine installs packages exactly as it would from the real registry.

### Setup

```bash
# Install Verdaccio globally
npm install -g verdaccio

# Start it (runs on http://localhost:4873 by default)
verdaccio
```

### Publish to Verdaccio

```bash
# From the autofix-hub repo root
pnpm -r publish --registry http://localhost:4873 --access public --no-git-checks
```

This publishes all four packages (`@autofix-hub/core`, `plugin-apiiro`, `plugin-aqa`, `plugin-sonarqube`) to your local registry.

### Install from Verdaccio (on another machine or project)

Replace `<host-ip>` with the IP of the machine running Verdaccio (or `localhost` if same machine):

```bash
npm install -g @autofix-hub/core @autofix-hub/plugin-apiiro \
  @autofix-hub/plugin-aqa @autofix-hub/plugin-sonarqube \
  --registry http://<host-ip>:4873

# Verify
autofix-hub --help
```

### Verdaccio tips

- Config file is at `~/.config/verdaccio/config.yaml`
- To allow access from other machines on your network, set `listen: 0.0.0.0:4873` in the config
- Verdaccio proxies unknown packages to the real npm registry, so dependencies like `commander` and `express` resolve automatically
- To re-publish after changes, bump the version or delete the old tarball from Verdaccio's storage directory

## Option 2: Tarballs (`pnpm run pack`)

A standalone script (`scripts/pack.js`) creates installable tarballs for all packages and generates an install script. It automatically handles the `workspace:*` dependency rewriting so plugins resolve `@autofix-hub/core` correctly when installed from tarballs.

No prior installation of autofix-hub is required — just clone the repo and run the script.

### Create tarballs

```bash
# From the repo root (requires pnpm and node)
pnpm run pack
```

Or directly:

```bash
node scripts/pack.js
```

This will:

1. Pack `@autofix-hub/core` into `dist/`
2. For each plugin, temporarily rewrite `workspace:*` to a `file:` reference pointing at the core tarball, pack it, then restore the original `package.json`
3. Generate `dist/install.sh` for easy installation
4. Print install instructions

Output:

```
dist/
  autofix-hub-core-0.1.0.tgz
  autofix-hub-plugin-apiiro-0.1.0.tgz
  autofix-hub-plugin-aqa-0.1.0.tgz
  autofix-hub-plugin-sonarqube-0.1.0.tgz
  install.sh
```

### Install from tarballs

Copy the `dist/` folder to the target machine, then use one of these methods:

**Option A — Use the generated install script:**

```bash
cd dist && bash install.sh /path/to/target-project
```

**Option B — Manual npm install (order matters — core first):**

```bash
cd /path/to/target-project
npm install /path/to/dist/autofix-hub-core-0.1.0.tgz
npm install /path/to/dist/autofix-hub-plugin-apiiro-0.1.0.tgz
npm install /path/to/dist/autofix-hub-plugin-aqa-0.1.0.tgz
npm install /path/to/dist/autofix-hub-plugin-sonarqube-0.1.0.tgz
```

**Option C — Pack and install globally in one step:**

```bash
pnpm run pack:install
```

This creates the tarballs and then runs `npm install -g` for each one, making `autofix-hub` available system-wide.

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

## Option 2: Tarballs

Simpler but requires manual dependency wiring.

### Build tarballs

```bash
cd packages/core && pnpm pack && mv *.tgz ../../dist/
cd ../plugin-apiiro && pnpm pack && mv *.tgz ../../dist/
cd ../plugin-aqa && pnpm pack && mv *.tgz ../../dist/
cd ../plugin-sonarqube && pnpm pack && mv *.tgz ../../dist/
```

### Install from tarballs

Copy the `dist/` folder to the target machine, then:

```bash
npm install -g ./dist/autofix-hub-core-0.1.0.tgz \
  ./dist/autofix-hub-plugin-apiiro-0.1.0.tgz \
  ./dist/autofix-hub-plugin-aqa-0.1.0.tgz \
  ./dist/autofix-hub-plugin-sonarqube-0.1.0.tgz
```

**Note:** `workspace:*` dependencies in plugins won't resolve from tarballs. Before packing plugins, temporarily replace `"@autofix-hub/core": "workspace:*"` with `"@autofix-hub/core": "0.1.0"` in each plugin's `package.json`, then install the core tarball first.

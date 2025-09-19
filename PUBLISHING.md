# Publishing to NPM

**Guide by AI Hive® at [O2.services](https://o2.services)**

[← Back to README](./README.md) | [Documentation](./docs/) | [NPM Package](https://www.npmjs.com/package/@alexanderfedin/async-queue)

## Prerequisites

1. **Create an npm account** (if you don't have one):
   - Go to https://www.npmjs.com/signup
   - Verify your email

2. **Login to npm** from your terminal:
   ```bash
   npm login
   ```
   Enter your username, password, and email when prompted.

## Publishing Steps

### 1. First-time Publishing (version 1.0.0)

Since this is a scoped package (`@alexanderfedin/async-queue`), run:

```bash
npm publish --access public
```

The `--access public` flag is needed for scoped packages to be publicly available (already configured in package.json).

### 2. Future Updates

1. **Update the version** in package.json:
   ```bash
   # For patch releases (bug fixes): 1.0.0 -> 1.0.1
   npm version patch

   # For minor releases (new features): 1.0.0 -> 1.1.0
   npm version minor

   # For major releases (breaking changes): 1.0.0 -> 2.0.0
   npm version major
   ```

2. **Commit and push** the version change:
   ```bash
   git push origin main
   git push --tags  # npm version creates a git tag
   ```

3. **Publish** the update:
   ```bash
   npm publish
   ```

## Pre-publish Checklist

✅ **Tests pass**: `npm test`
✅ **Build works**: `npm run build`
✅ **Examples work**: `npm run example:iterator`
✅ **Documentation updated**: README.md is current
✅ **Version appropriate**: package.json version is correct
✅ **Clean working directory**: All changes committed

## Package Contents

Your package will include:
- `dist/` - Compiled JavaScript and TypeScript definitions
- `LICENSE` - MIT license
- `README.md` - Documentation
- `package.json` - Package metadata

Total size: ~8.2 KB (packed)

## After Publishing

1. **Verify on npm**:
   - Visit: https://www.npmjs.com/package/@alexanderfedin/async-queue
   - Check that README displays correctly
   - Verify all metadata is correct

2. **Test installation**:
   ```bash
   # In a different directory
   npm install @alexanderfedin/async-queue
   ```

3. **Update GitHub**:
   - Create a GitHub release with the same version tag
   - Add release notes highlighting new features

## Troubleshooting

- **E403 Forbidden**: You may need to verify your email or use `--access public`
- **E426 Upgrade Required**: Update npm: `npm install -g npm@latest`
- **Name unavailable**: The exact package name might be taken

## Version History

- `1.0.0` - Initial release with AsyncIterator support
  - High-performance circular buffer implementation
  - Full TypeScript support
  - AsyncIterator/AsyncEnumerator adapter
  - Comprehensive test coverage
  - 10M ops/sec throughput
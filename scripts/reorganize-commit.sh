#!/bin/bash

echo "=== Repository Reorganization Script ==="
echo ""
cd /Users/alexanderfedin/Projects/push-pull

# Step 1: Create backup commit
echo "Step 1: Creating backup commit..."
git add -A
git commit -m "Backup: Before repository reorganization

- Saving current state before major reorganization
- All TypeScript files and tests included
- Performance benchmarks documented"

# Step 2: Push backup
echo "Step 2: Pushing backup to remote..."
git push origin main

# Step 3: Clean up unnecessary files
echo "Step 3: Cleaning up unnecessary files..."
rm -f simple-bench.js 2>/dev/null
rm -f BENCHMARK-LIBRARIES.md 2>/dev/null
rm -f benchmark/run-benchmark.js 2>/dev/null
rm -f benchmark/async-queue.bench.ts 2>/dev/null
rm -f benchmark/generate-performance-report.ts 2>/dev/null
rm -rf csharp/ 2>/dev/null

# Step 4: Run tests to verify
echo "Step 4: Building and testing..."
npm run build
npm test
if [ $? -ne 0 ]; then
  echo "Tests failed! Please fix before committing."
  exit 1
fi

# Step 5: Final commit
echo "Step 5: Creating final reorganization commit..."
git add -A
git commit -m "Reorganize repository for professional GitHub presentation

Changes:
- Added comprehensive README with performance metrics
- Added GitHub Actions CI workflow for multi-platform testing
- Added code quality configs (.editorconfig, .prettierrc)
- Removed duplicate and unnecessary files
- Cleaned up benchmark directory structure
- Updated documentation with actual benchmark results

The repository now follows GitHub best practices with:
- Professional README with badges
- CI/CD pipeline
- Code quality tooling
- Clean directory structure
- Comprehensive test coverage"

# Step 6: Push final changes
echo "Step 6: Pushing reorganized repository..."
git push origin main

echo ""
echo "=== Reorganization Complete! ==="
echo ""
echo "Your repository now has:"
echo "✅ Professional README with performance badges"
echo "✅ GitHub Actions CI/CD pipeline"
echo "✅ Code quality configuration"
echo "✅ Clean directory structure"
echo "✅ Comprehensive documentation"
echo ""
echo "Next steps:"
echo "1. Check GitHub Actions to ensure CI passes"
echo "2. Consider adding Codecov for coverage reports"
echo "3. Add version tags for releases"
echo "4. Update npm package if publishing"
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const archivedDangerousSqlDir = normalizePath(
  path.join(repoRoot, 'archived-dangerous-sql')
);

const skippedDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.netlify',
  '.vercel',
]);

const destructiveSqlPattern =
  /\b(delete\s+from|truncate(?:\s+table)?|drop\s+table|drop\s+schema)\b/i;
const codeDeletePattern =
  /(\.from\s*\([\s\S]{0,250}\.delete\s*\(|storage[\s\S]{0,250}\.remove\s*\(|removeStorageFiles\s*\()/i;
const protectedDataPattern =
  /\b(attendance_records|training_sessions|storage\.objects|quiz_results|student_attempts|certificates|wallet_cards)\b|attendance-photos|signatures/i;

const findings = [];
const warnings = [];

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function isInside(parentDir, filePath) {
  const relativePath = path.relative(parentDir, filePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }

    if (!entry.isFile()) continue;

    inspectFile(path.join(dir, entry.name));
  }
}

function inspectFile(filePath) {
  const relativePath = normalizePath(path.relative(repoRoot, filePath));

  if (relativePath === 'scripts/check-dangerous-sql.js') return;

  const extension = path.extname(filePath).toLowerCase();
  const shouldScan =
    ['.sql', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension) ||
    relativePath === 'package.json';

  if (!shouldScan) return;

  const content = fs.readFileSync(filePath, 'utf8');
  const touchesProtectedData = protectedDataPattern.test(content);

  if (
    extension === '.sql' &&
    destructiveSqlPattern.test(content) &&
    touchesProtectedData &&
    !isInside(archivedDangerousSqlDir, filePath)
  ) {
    findings.push(relativePath);
    return;
  }

  if (
    extension !== '.sql' &&
    codeDeletePattern.test(content) &&
    touchesProtectedData
  ) {
    warnings.push(relativePath);
  }
}

walk(repoRoot);

if (warnings.length > 0) {
  console.warn('Delete-capable code touching protected ExCourse terms was found:');
  for (const file of warnings.sort()) {
    console.warn(`- ${file}`);
  }
  console.warn('Review these paths before changing delete behavior.');
}

if (findings.length > 0) {
  console.error('Blocked destructive SQL touching protected ExCourse data:');
  for (const file of findings.sort()) {
    console.error(`- ${file}`);
  }
  console.error('Move historical SQL into archived-dangerous-sql/ or redesign it to be non-destructive by default.');
  process.exit(1);
}

console.log('Safety check passed: no unarchived destructive SQL touching protected ExCourse data found.');

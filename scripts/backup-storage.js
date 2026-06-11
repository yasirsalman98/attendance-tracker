import 'dotenv/config';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';

const buckets = ['signatures', 'attendance-photos', 'instructor-templates'];
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rootDir = process.cwd();

function getTimestamp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];

  return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function cleanPathPart(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .filter((part) => part !== '.' && part !== '..')
    .join('/');
}

function joinObjectPath(prefix, name) {
  const cleanPrefix = cleanPathPart(prefix);
  const cleanName = cleanPathPart(name);

  return [cleanPrefix, cleanName].filter(Boolean).join('/');
}

function isFolder(item) {
  return !item.id && !item.metadata;
}

async function listFiles(client, bucket, prefix = '') {
  const found = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });

    if (error) {
      throw new Error(`${bucket}/${prefix || ''}: ${error.message}`);
    }

    const items = data || [];

    for (const item of items) {
      const objectPath = joinObjectPath(prefix, item.name);

      if (isFolder(item)) {
        found.push(...(await listFiles(client, bucket, objectPath)));
      } else {
        found.push(objectPath);
      }
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return found;
}

async function saveFile(client, bucket, objectPath, backupDir) {
  const { data, error } = await client.storage.from(bucket).download(objectPath);

  if (error) {
    throw new Error(error.message);
  }

  const arrayBuffer = await data.arrayBuffer();
  const localPath = path.join(backupDir, bucket, ...cleanPathPart(objectPath).split('/'));

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, Buffer.from(arrayBuffer));

  return localPath;
}

async function addFolderToZip(zip, folder, relativeRoot = folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);

    if (entry.isDirectory()) {
      await addFolderToZip(zip, fullPath, relativeRoot);
      continue;
    }

    if (!entry.isFile()) continue;

    const relativePath = path.relative(relativeRoot, fullPath).replace(/\\/g, '/');
    zip.file(relativePath, await fs.readFile(fullPath));
  }
}

async function createZip(backupDir) {
  const zip = new JSZip();
  await addFolderToZip(zip, backupDir);

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const zipPath = `${backupDir}.zip`;

  await fs.writeFile(zipPath, zipBuffer);
  return zipPath;
}

async function main() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_URL or VITE_SUPABASE_URL, or missing SUPABASE_SERVICE_ROLE_KEY.'
    );
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const backupDir = path.join(rootDir, 'storage-backups', getTimestamp());

  if (fsSync.existsSync(backupDir)) {
    throw new Error(`Backup folder already exists: ${backupDir}`);
  }

  await fs.mkdir(backupDir, { recursive: true });

  const summary = new Map();
  const failures = [];
  let totalFiles = 0;

  for (const bucket of buckets) {
    console.log(`Listing ${bucket}...`);
    const files = await listFiles(client, bucket);
    let savedCount = 0;

    for (const objectPath of files) {
      try {
        await saveFile(client, bucket, objectPath, backupDir);
        savedCount += 1;
      } catch (error) {
        failures.push({
          bucket,
          path: objectPath,
          error: error?.message || 'Unknown error',
        });
      }
    }

    summary.set(bucket, savedCount);
    totalFiles += savedCount;
  }

  let zipPath = '';

  try {
    zipPath = await createZip(backupDir);
  } catch (error) {
    failures.push({
      bucket: 'local-zip',
      path: backupDir,
      error: error?.message || 'Unable to create ZIP file',
    });
  }

  console.log('\nSupabase Storage backup summary');
  console.log('Buckets backed up:');

  for (const bucket of buckets) {
    console.log(`- ${bucket}: ${summary.get(bucket) || 0} files`);
  }

  console.log(`Total files downloaded: ${totalFiles}`);
  console.log(`Failed files: ${failures.length}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`- ${failure.bucket}/${failure.path}: ${failure.error}`);
    }
  }

  console.log(`Backup folder: ${backupDir}`);

  if (zipPath) {
    console.log(`ZIP file: ${zipPath}`);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});

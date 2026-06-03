/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { debuglog } from 'node:util';
import JSZip from 'jszip';
import { Messages, SfError } from '@salesforce/core';
import { findBaseDirectory, getPackageType, type CodeType } from './nativeScan.js';
import { spawnAsync, type SpawnError } from './spawnHelper.js';

const debug = debuglog('datacustomcode');

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-data-code-extension', 'datacodeBinaryExecutor');

export const ZIP_FILE_NAME = 'deployment.zip';
export const DEPENDENCIES_ARCHIVE_NAME = 'native_dependencies';
export const DEPENDENCIES_ARCHIVE_FULL_NAME = `${DEPENDENCIES_ARCHIVE_NAME}.tar.gz`;
export const DEPENDENCIES_ARCHIVE_PATH = path.join('payload', 'archives', DEPENDENCIES_ARCHIVE_FULL_NAME);
export const PY_FILES_PATH = path.join('payload', 'py-files');
export const DOCKER_IMAGE_NAME = 'datacloud-custom-code-dependency-builder';
const PLATFORM_ENV = { DOCKER_DEFAULT_PLATFORM: 'linux/amd64' } as const;

export type ZipResult = {
  archivePath: string;
  fileCount: number;
  archiveSizeBytes: number;
};

/**
 * Returns true when `requirements.txt` (in the parent of `directory`) exists
 * and has at least one non-comment, non-blank line.
 *
 * Mirrors `has_nonempty_requirements_file` in `datacustomcode/deploy.py`.
 */
export function hasNonemptyRequirementsFile(directory: string): boolean {
  const requirementsPath = path.join(path.dirname(directory), 'requirements.txt');
  try {
    if (!existsSync(requirementsPath) || !statSync(requirementsPath).isFile()) {
      return false;
    }
    const contents = readFileSync(requirementsPath, 'utf-8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return true;
      }
    }
  } catch (err) {
    debug('error reading requirements.txt at %s: %o', requirementsPath, err);
  }
  return false;
}

export function dockerBuildCmd(network: string): string[] {
  const args = ['build', '-t', DOCKER_IMAGE_NAME, '--file', 'Dockerfile.dependencies', '.'];
  if (network !== 'default') {
    args.push('--network', network);
  }
  return args;
}

export function dockerRunCmd(network: string, tempDir: string): string[] {
  // Docker expects forward slashes in the volume mount path, even on Windows.
  const mountPath = tempDir.replace(/\\/g, '/');
  const args = ['run', '--rm', '-v', `${mountPath}:/workspace`, DOCKER_IMAGE_NAME];
  if (network !== 'default') {
    args.push('--network', network);
  }
  return args;
}

async function dockerImageExists(): Promise<boolean> {
  try {
    const { stdout } = await spawnAsync('docker', ['images', '-q', DOCKER_IMAGE_NAME]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function copyFile(src: string, dest: string): Promise<void> {
  const data = new Uint8Array(await readFile(src));
  await writeFile(dest, data);
}

async function copyTree(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  await Promise.all(
    entries.map((entry) => {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        return copyTree(srcPath, destPath);
      }
      if (entry.isFile()) {
        return copyFile(srcPath, destPath);
      }
      return Promise.resolve();
    })
  );
}

/**
 * Runs the Docker-based dependency builder. For scripts, copies the resulting
 * `native_dependencies.tar.gz` into `payload/archives/`. For functions, copies
 * the generated `py-files/` tree into `payload/py-files/`.
 *
 * Mirrors `prepare_dependency_archive` in `datacustomcode/deploy.py`.
 */
export async function prepareDependencyArchive(
  directory: string,
  dockerNetwork: string,
  packageType: CodeType,
  log: (message: string) => void = (): void => {}
): Promise<void> {
  const dockerEnv = { ...process.env, ...PLATFORM_ENV };
  const imageExists = await dockerImageExists();

  if (!imageExists) {
    log(`Building docker image with docker network: ${dockerNetwork}...`);
    const buildArgs = dockerBuildCmd(dockerNetwork);
    debug('docker build: %o', buildArgs);
    await spawnAsync('docker', buildArgs, { env: dockerEnv });
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'datacustomcode-deps-'));
  try {
    log(`Building dependencies archive with docker network: ${dockerNetwork}`);
    await copyFile('requirements.txt', path.join(tempDir, 'requirements.txt'));
    await copyFile('build_native_dependencies.sh', path.join(tempDir, 'build_native_dependencies.sh'));

    const runArgs = dockerRunCmd(dockerNetwork, tempDir);
    debug('docker run: %o', runArgs);
    await spawnAsync('docker', runArgs, { env: dockerEnv });

    if (packageType === 'function') {
      const sourcePyFiles = path.join(tempDir, 'py-files');
      if (existsSync(sourcePyFiles)) {
        log(`py-files directory found at ${sourcePyFiles}. Copying to payload directory...`);
        await mkdir(path.dirname(PY_FILES_PATH), { recursive: true });
        if (existsSync(PY_FILES_PATH)) {
          rmSync(PY_FILES_PATH, { recursive: true, force: true });
        }
        await copyTree(sourcePyFiles, PY_FILES_PATH);
        log(`py-files copied to ${PY_FILES_PATH}`);
      } else {
        log(`No py-files directory found at ${sourcePyFiles}. Skipping py-files copy.`);
      }
    } else {
      const archivesTempPath = path.join(tempDir, DEPENDENCIES_ARCHIVE_FULL_NAME);
      await mkdir(path.dirname(DEPENDENCIES_ARCHIVE_PATH), { recursive: true });
      await copyFile(archivesTempPath, DEPENDENCIES_ARCHIVE_PATH);
      log(`Dependencies archived to ${DEPENDENCIES_ARCHIVE_PATH}`);
    }
  } finally {
    // ignore_cleanup_errors equivalent: Docker may leave files the host can't
    // delete (e.g., on Windows). Files we needed are already copied out.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      debug('temp dir cleanup error (ignored): %o', err);
    }
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  async function walk(current: string): Promise<string[]> {
    const entries = await readdir(current, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          return walk(full);
        }
        if (entry.isFile() && entry.name !== '.DS_Store') {
          return [full];
        }
        return [];
      })
    );
    return nested.flat();
  }
  return walk(directory);
}

/**
 * Creates `deployment.zip` (DEFLATE-compressed) at the current working
 * directory containing every file under `directory` except `.DS_Store`.
 * Archive entry names are relative to `directory`, matching the Python
 * `os.path.relpath(abs_path, directory)` behavior.
 */
export async function createZip(directory: string): Promise<ZipResult> {
  const archive = new JSZip();
  const files = await collectFiles(directory);

  const entries = await Promise.all(
    files.map(async (absPath) => {
      const arcname = path.relative(directory, absPath);
      // Use forward slashes inside the zip so the archive is portable across
      // platforms (Python's zipfile follows the same convention).
      const portableName = arcname.split(path.sep).join('/');
      const [data, entryStat] = await Promise.all([readFile(absPath), stat(absPath)]);
      return { portableName, data: new Uint8Array(data), mtime: entryStat.mtime };
    })
  );
  for (const entry of entries) {
    archive.file(entry.portableName, entry.data, {
      date: entry.mtime,
      createFolders: false,
    });
  }

  // Drop the implicit folder entries JSZip materializes for any path with a "/"
  // — the Python zipfile reference adds files only, never directory entries, so
  // we strip them here to keep the archives byte-comparable in test diffs.
  for (const name of Object.keys(archive.files)) {
    if (archive.files[name].dir) {
      archive.remove(name);
    }
  }

  const buffer = await archive.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: process.platform === 'win32' ? 'DOS' : 'UNIX',
  });

  await writeFile(ZIP_FILE_NAME, buffer);
  return {
    archivePath: ZIP_FILE_NAME,
    fileCount: files.length,
    archiveSizeBytes: buffer.byteLength,
  };
}

/**
 * High-level zip command: optionally builds the dependency archive, then
 * creates `deployment.zip`. Mirrors the Python CLI `zip` command in
 * `datacustomcode/cli.py`.
 */
export async function zip(
  directory: string,
  dockerNetwork: string,
  log: (message: string) => void = (): void => {}
): Promise<ZipResult> {
  if (!existsSync(directory)) {
    throw new SfError(
      messages.getMessage('error.zipExecutionFailed', [directory, `Package directory not found at '${directory}'`]),
      'PackageDirNotFound'
    );
  }

  const baseDirectory = findBaseDirectory(directory);
  const packageType = await getPackageType(baseDirectory);

  if (hasNonemptyRequirementsFile(directory)) {
    await prepareDependencyArchive(directory, dockerNetwork, packageType, log);
  } else {
    log(`Skipping dependency archive: requirements.txt is missing or empty in ${directory}`);
  }

  debug('zipping directory %s', directory);
  const result = await createZip(directory);
  debug('created zip at %s (%d files, %d bytes)', result.archivePath, result.fileCount, result.archiveSizeBytes);
  return result;
}

/**
 * Convenience wrapper that surfaces docker / zip failures as SfError so the
 * Salesforce CLI framework renders them with consistent action hints.
 */
export async function zipWithSfError(
  directory: string,
  dockerNetwork: string,
  log?: (message: string) => void
): Promise<ZipResult> {
  try {
    return await zip(directory, dockerNetwork, log);
  } catch (error) {
    if (error instanceof SfError) {
      throw error;
    }
    const spawnError = error as SpawnError;
    const detail = spawnError.stderr?.trim() ?? (error instanceof Error ? error.message : String(error));
    throw new SfError(
      messages.getMessage('error.zipExecutionFailed', [directory, detail]),
      'ZipExecutionFailed',
      messages.getMessages('actions.zipExecutionFailed')
    );
  }
}

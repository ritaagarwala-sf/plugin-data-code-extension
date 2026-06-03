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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { expect } from 'chai';
import JSZip from 'jszip';
import {
  createZip,
  dockerBuildCmd,
  dockerRunCmd,
  hasNonemptyRequirementsFile,
  zip,
  ZIP_FILE_NAME,
} from '../../src/utils/zipBuilder.js';

const SDK_CONFIG_DIR = '.datacustomcode_proj';
const SDK_CONFIG_FILE = 'sdk_config.json';

function makeTempDir(prefix = 'zipBuilder-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeSdkConfig(baseDir: string, config: unknown): void {
  const sdkDir = path.join(baseDir, SDK_CONFIG_DIR);
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(path.join(sdkDir, SDK_CONFIG_FILE), JSON.stringify(config, null, 2));
}

describe('zipBuilder.hasNonemptyRequirementsFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when requirements.txt is missing', () => {
    const payload = path.join(tempDir, 'payload');
    mkdirSync(payload);
    expect(hasNonemptyRequirementsFile(payload)).to.equal(false);
  });

  it('returns false when requirements.txt only has comments and blank lines', () => {
    const payload = path.join(tempDir, 'payload');
    mkdirSync(payload);
    writeFileSync(path.join(tempDir, 'requirements.txt'), '# comment\n\n   \n# another\n');
    expect(hasNonemptyRequirementsFile(payload)).to.equal(false);
  });

  it('returns true when requirements.txt has at least one non-comment line', () => {
    const payload = path.join(tempDir, 'payload');
    mkdirSync(payload);
    writeFileSync(path.join(tempDir, 'requirements.txt'), '# comment\npandas==2.0.0\n');
    expect(hasNonemptyRequirementsFile(payload)).to.equal(true);
  });

  it('treats indented comments as comments', () => {
    const payload = path.join(tempDir, 'payload');
    mkdirSync(payload);
    writeFileSync(path.join(tempDir, 'requirements.txt'), '   # indented comment\n');
    expect(hasNonemptyRequirementsFile(payload)).to.equal(false);
  });
});

describe('zipBuilder docker command builders', () => {
  it('builds a docker build command without --network for the default network', () => {
    expect(dockerBuildCmd('default')).to.deep.equal([
      'build',
      '-t',
      'datacloud-custom-code-dependency-builder',
      '--file',
      'Dockerfile.dependencies',
      '.',
    ]);
  });

  it('appends --network when not the default', () => {
    expect(dockerBuildCmd('host')).to.deep.equal([
      'build',
      '-t',
      'datacloud-custom-code-dependency-builder',
      '--file',
      'Dockerfile.dependencies',
      '.',
      '--network',
      'host',
    ]);
  });

  it('builds a docker run command with the temp dir mounted', () => {
    expect(dockerRunCmd('default', '/tmp/work')).to.deep.equal([
      'run',
      '--rm',
      '-v',
      '/tmp/work:/workspace',
      'datacloud-custom-code-dependency-builder',
    ]);
  });

  it('normalizes Windows-style backslashes in the mount path', () => {
    const out = dockerRunCmd('host', 'C:\\Users\\x\\tmp');
    expect(out).to.include('C:/Users/x/tmp:/workspace');
    expect(out).to.include('--network');
    expect(out).to.include('host');
  });
});

describe('zipBuilder.createZip', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates deployment.zip with all non-DS_Store files at relative paths', async () => {
    const payload = path.join(tempDir, 'payload');
    mkdirSync(path.join(payload, 'sub'), { recursive: true });
    writeFileSync(path.join(payload, 'a.py'), 'print(1)');
    writeFileSync(path.join(payload, 'sub', 'b.py'), 'print(2)');
    writeFileSync(path.join(payload, '.DS_Store'), 'junk');

    const result = await createZip('payload');

    expect(result.archivePath).to.equal(ZIP_FILE_NAME);
    expect(result.fileCount).to.equal(2);
    expect(result.archiveSizeBytes).to.be.greaterThan(0);
    expect(existsSync(ZIP_FILE_NAME)).to.equal(true);

    const buf = new Uint8Array(readFileSync(ZIP_FILE_NAME));
    const unzipped = await JSZip.loadAsync(buf);
    const names = Object.keys(unzipped.files).sort();
    expect(names).to.deep.equal(['a.py', 'sub/b.py']);

    const aContent = await unzipped.files['a.py'].async('string');
    expect(aContent).to.equal('print(1)');
  });

  it('writes an empty archive when the directory has no files', async () => {
    const payload = path.join(tempDir, 'empty');
    mkdirSync(payload);

    const result = await createZip('empty');
    expect(result.fileCount).to.equal(0);
    expect(existsSync(ZIP_FILE_NAME)).to.equal(true);
  });

  it('omits implicit folder entries so output matches the Python zipfile format', async () => {
    const payload = path.join(tempDir, 'tree');
    mkdirSync(path.join(payload, 'inner'), { recursive: true });
    writeFileSync(path.join(payload, 'top.py'), 'top');
    writeFileSync(path.join(payload, 'inner', 'nested.py'), 'nested');

    await createZip('tree');
    const buf = new Uint8Array(readFileSync(ZIP_FILE_NAME));
    const unzipped = await JSZip.loadAsync(buf);
    for (const name of Object.keys(unzipped.files)) {
      expect(unzipped.files[name].dir, `entry ${name} should not be a directory`).to.equal(false);
    }
  });
});

describe('zipBuilder.zip orchestration', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips dependency archive when requirements.txt is empty and produces a deployment.zip', async () => {
    const project = path.join(tempDir, 'proj');
    const payload = path.join(project, 'payload');
    mkdirSync(payload, { recursive: true });
    writeSdkConfig(project, { type: 'script' });
    writeFileSync(path.join(project, 'requirements.txt'), '# only comments\n');
    writeFileSync(path.join(payload, 'entrypoint.py'), 'pass');

    const logs: string[] = [];
    const result = await zip(path.join('proj', 'payload'), 'default', (m) => logs.push(m));

    expect(result.fileCount).to.equal(1);
    expect(result.archivePath).to.equal(ZIP_FILE_NAME);
    expect(logs.some((m) => m.includes('Skipping dependency archive'))).to.equal(true);
  });

  it('throws a clear error when the package directory does not exist', async () => {
    let caught: Error | undefined;
    try {
      await zip(path.join(tempDir, 'missing'), 'default');
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught!.message).to.match(/Package directory not found/);
  });
});

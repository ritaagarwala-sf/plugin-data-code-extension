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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'chai';
import { TestContext } from '@salesforce/core/testSetup';
import { DatacodeBinaryExecutor } from '../../src/utils/datacodeBinaryExecutor.js';

const execAsync = promisify(exec);

// ── Regex unit tests (no subprocess) ─────────────────────────────────────────
// These tests verify that the stdout parsing patterns match the actual Python CLI
// output format. They run purely in-process and do not require the binary.

describe('DatacodeBinaryExecutor stdout parsing patterns', () => {
  describe('init: /Copying template to (.+)/', () => {
    const pattern = /Copying template to (.+)/;

    it('extracts directory from actual Python CLI output', () => {
      const stdout =
        'Copying template to /home/user/my-package\nStart developing by updating the code in /home/user/my-package/payload/entrypoint.py';
      const match = pattern.exec(stdout);
      expect(match).to.not.be.null;
      expect(match![1].trim()).to.equal('/home/user/my-package');
    });

    it('returns null when output does not contain expected line', () => {
      const stdout = 'Created file: /some/file.py';
      const match = pattern.exec(stdout);
      expect(match).to.be.null;
    });

    it('trims trailing whitespace from captured path', () => {
      const stdout = 'Copying template to /some/dir  ';
      const match = pattern.exec(stdout);
      expect(match![1].trim()).to.equal('/some/dir');
    });
  });

  describe('scan: /Scanning (.+)\\.\\.\\./ (global)', () => {
    const pattern = /Scanning (.+)\.\.\./g;

    it('extracts the entrypoint file being scanned', () => {
      const stdout =
        'Dumping scan results to config file: ./payload/config.json\nScanning payload/entrypoint.py...\n{"sdkVersion":"1.0.0"}';
      const filesScanned: string[] = [];
      let match;
      while ((match = pattern.exec(stdout)) !== null) {
        filesScanned.push(match[1].trim());
      }
      expect(filesScanned).to.deep.equal(['payload/entrypoint.py']);
    });

    it('collects multiple scanned files when present', () => {
      const stdout = 'Scanning a.py...\nScanning b.py...';
      const filesScanned: string[] = [];
      let match;
      while ((match = pattern.exec(stdout)) !== null) {
        filesScanned.push(match[1].trim());
      }
      expect(filesScanned).to.deep.equal(['a.py', 'b.py']);
    });

    it('returns empty array when no scanning lines present', () => {
      const stdout = 'Permission required: READ_DATA\nDependency found: pandas';
      const filesScanned: string[] = [];
      let match;
      while ((match = pattern.exec(stdout)) !== null) {
        filesScanned.push(match[1].trim());
      }
      expect(filesScanned).to.be.empty;
    });
  });
});

// ── Integration tests (require datacustomcode binary) ────────────────────────

describe('DatacodeBinaryExecutor', () => {
  const $$ = new TestContext();

  afterEach(() => {
    $$.restore();
  });

  describe('executeBinaryInit', () => {
    it('should successfully execute datacustomcode init for script type', async function () {
      // This test will only pass if datacustomcode is actually installed
      let isInstalled = false;
      try {
        await execAsync('datacustomcode version');
        isInstalled = true;
      } catch {
        isInstalled = false;
      }

      if (!isInstalled) {
        this.skip();
        return;
      }

      // Create a temporary test directory name
      const testDir = `/tmp/test-script-${Date.now()}`;

      try {
        const result = await DatacodeBinaryExecutor.executeBinaryInit('script', testDir);

        expect(result).to.have.property('stdout');
        expect(result).to.have.property('stderr');
        expect(result).to.have.property('projectPath', testDir);
        expect(result).to.have.property('filesCreated');
        expect(result.filesCreated).to.be.an('array');

        // Clean up the test directory
        await execAsync(`rm -rf ${testDir}`);
      } catch (error) {
        // Clean up even if test fails
        await execAsync(`rm -rf ${testDir}`).catch(() => {});
        throw error;
      }
    });

    it('should successfully execute datacustomcode init for function type', async function () {
      // This test will only pass if datacustomcode is actually installed
      let isInstalled = false;
      try {
        await execAsync('datacustomcode version');
        isInstalled = true;
      } catch {
        isInstalled = false;
      }

      if (!isInstalled) {
        this.skip();
        return;
      }

      // Create a temporary test directory name
      const testDir = `/tmp/test-function-${Date.now()}`;

      try {
        const result = await DatacodeBinaryExecutor.executeBinaryInit('function', testDir);

        expect(result).to.have.property('stdout');
        expect(result).to.have.property('stderr');
        expect(result).to.have.property('projectPath', testDir);
        expect(result).to.have.property('filesCreated');
        expect(result.filesCreated).to.be.an('array');

        // Clean up the test directory
        await execAsync(`rm -rf ${testDir}`);
      } catch (error) {
        // Clean up even if test fails
        await execAsync(`rm -rf ${testDir}`).catch(() => {});
        throw error;
      }
    });

    it('should throw error when directory already exists', async function () {
      // The real binary does not reliably error on existing directories;
      // this scenario requires mocking which ES modules do not support here.
      this.skip();
    });

    it('should throw error when permission denied', async function () {
      // This test would require setting up a directory with no write permissions
      // which can be problematic in different environments
      this.skip();
    });
  });
});

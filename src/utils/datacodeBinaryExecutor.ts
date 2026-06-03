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
import { spawn } from 'node:child_process';
import { debuglog } from 'node:util';
import { SfError } from '@salesforce/core';

const debug = debuglog('datacustomcode');
import { Messages } from '@salesforce/core';
import { spawnAsync, type SpawnError } from './spawnHelper.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-data-code-extension', 'datacodeBinaryExecutor');

export type DatacodeZipExecutionResult = {
  stdout: string;
  stderr: string;
  archivePath?: string;
  fileCount?: number;
  archiveSize?: string;
};

export type DatacodeDeployExecutionResult = {
  stdout: string;
  stderr: string;
  deploymentId?: string;
  endpointUrl?: string;
  status?: string;
};

export type DatacodeRunExecutionResult = {
  stdout: string;
  stderr: string;
  status?: string;
  output?: string;
};

export class DatacodeBinaryExecutor {
  /**
   * Executes datacustomcode zip with the specified parameters.
   *
   * @param packageDir The directory containing the initialized package to zip
   * @param network Optional network configuration for Jupyter notebooks
   * @returns Execution result with stdout, stderr, and archive information
   * @throws SfError if execution fails
   */
  public static async executeBinaryZip(packageDir: string, network?: string): Promise<DatacodeZipExecutionResult> {
    const args = ['zip'];

    if (network) {
      args.push('--network', network);
    }

    args.push(packageDir);

    try {
      const { stdout, stderr } = await spawnAsync('datacustomcode', args, {
        timeout: 120_000,
      });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    } catch (error) {
      const spawnError = error as SpawnError;
      const binaryOutput = spawnError.stderr?.trim() ?? (error instanceof Error ? error.message : String(error));
      throw new SfError(
        messages.getMessage('error.zipExecutionFailed', [packageDir, binaryOutput]),
        'ZipExecutionFailed',
        messages.getMessages('actions.zipExecutionFailed')
      );
    }
  }

  /**
   * Executes datacustomcode deploy with the specified parameters.
   *
   * @param name The name of the package to deploy
   * @param version The version of the package
   * @param description The description of the package
   * @param packageDir The directory containing the packaged code
   * @param targetOrg The target Salesforce org username/alias
   * @param cpuSize The CPU size for the deployment
   * @param network Optional network configuration for Jupyter notebooks
   * @returns Execution result with stdout, stderr, and deployment details
   * @throws SfError if execution fails
   */
  public static async executeBinaryDeploy(
    name: string,
    version: string,
    description: string,
    packageDir: string,
    targetOrg: string,
    cpuSize: string,
    network?: string,
    useInFeature?: string
  ): Promise<DatacodeDeployExecutionResult> {
    // Build args array for spawn (avoids shell-escaping issues and enables streaming)
    const args = [
      'deploy',
      '--name',
      name,
      '--version',
      version,
      '--description',
      description,
      '--path',
      packageDir,
      '--sf-cli-org',
      targetOrg,
      '--cpu-size',
      cpuSize,
    ];

    if (network) {
      args.push('--network', network);
    }

    if (useInFeature) {
      args.push('--use-in-feature', useInFeature);
    }

    return new Promise((resolve, reject) => {
      debug('deploy spawn: datacustomcode %o', args);
      const child = spawn('datacustomcode', args, {
        timeout: 600_000,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        debug('deploy stdout chunk: %s', text);
        process.stdout.write(text);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        debug('deploy stderr chunk: %s', text);
        process.stderr.write(text);
      });

      child.on('close', (code) => {
        debug('deploy exit code: %d', code);
        const stdoutTrimmed = stdout.trim();
        const stderrTrimmed = stderr.trim();

        if (code !== 0) {
          const errorMessage = stderrTrimmed || `Process exited with code ${code ?? 'unknown'}`;

          if (errorMessage.includes('Authentication failed') || errorMessage.includes('Invalid credentials')) {
            const sfError = new SfError(
              messages.getMessage('error.deployAuthenticationFailed', [targetOrg]),
              'DeployAuthenticationFailed',
              messages.getMessages('actions.deployAuthenticationFailed')
            );
            sfError.data = { stdout: stdoutTrimmed };
            reject(sfError);
            return;
          }

          const sfError = new SfError(
            messages.getMessage('error.deployExecutionFailed', [name, errorMessage]),
            'DeployExecutionFailed',
            messages.getMessages('actions.deployExecutionFailed')
          );
          sfError.data = { stdout: stdoutTrimmed };
          reject(sfError);
          return;
        }

        resolve({
          stdout: stdoutTrimmed,
          stderr: stderrTrimmed,
        });
      });

      child.on('error', (err) => {
        debug('deploy spawn error: %o', err);
        const sfError = new SfError(
          messages.getMessage('error.deployExecutionFailed', [name, err.message]),
          'DeployExecutionFailed',
          messages.getMessages('actions.deployExecutionFailed')
        );
        reject(sfError);
      });
    });
  }

  /**
   * Executes datacustomcode run with the specified parameters.
   *
   * @param packageDir The package directory (positional argument)
   * @param targetOrg Optional target Salesforce org username/alias (required for scripts, not for functions)
   * @param testWith Optional path to test.json file for function testing
   * @param configFile Optional path to a config file
   * @param dependencies Optional dependencies override
   * @returns Execution result with stdout, stderr, and parsed run output
   * @throws SfError if execution fails
   */
  public static async executeBinaryRun(
    packageDir: string,
    targetOrg?: string,
    testWith?: string,
    configFile?: string,
    dependencies?: string
  ): Promise<DatacodeRunExecutionResult> {
    const args = ['run'];

    if (targetOrg) {
      args.push('--sf-cli-org', targetOrg);
    }

    if (testWith) {
      args.push('--test-with', testWith);
    }

    if (configFile) {
      args.push('--config-file', configFile);
    }

    if (dependencies) {
      args.push('--dependencies', dependencies);
    }

    args.push(packageDir);

    try {
      const { stdout, stderr } = await spawnAsync('datacustomcode', args, {
        timeout: 300_000,
      });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    } catch (error) {
      const spawnError = error as SpawnError;
      const errorMessage = spawnError.message ?? String(error);

      if (errorMessage.includes('Authentication failed') || errorMessage.includes('Invalid credentials')) {
        throw new SfError(
          messages.getMessage('error.runAuthenticationFailed', [targetOrg ?? 'target org']),
          'RunAuthenticationFailed',
          messages.getMessages('actions.runAuthenticationFailed')
        );
      }

      // Surface the binary's stderr directly so any runtime error is shown as-is.
      // File-existence checks for entrypoint and config-file are already handled by
      // the CLI flag layer (exists: true), so those patterns are not matched here.
      const binaryOutput = spawnError.stderr?.trim() ?? errorMessage;
      throw new SfError(
        messages.getMessage('error.runExecutionFailed', [binaryOutput]),
        'RunExecutionFailed',
        messages.getMessages('actions.runExecutionFailed')
      );
    }
  }
}

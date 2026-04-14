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
import { get } from 'node:https';
import { SfError } from '@salesforce/core';
import { Messages } from '@salesforce/core';
import { spawnAsync } from './spawnHelper.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-data-code-extension', 'pipChecker');

export type PipPackageInfo = {
  name: string;
  version: string;
  location: string;
  pipCommand: string;
};

export type PipUpdateInfo = {
  packageName: string;
  installedVersion: string;
  latestVersion: string;
  pipCommand: string;
};

type PipCommand = { cmd: string; args: string[] };

export class PipChecker {
  private static readonly PIP_COMMANDS: PipCommand[] = [
    { cmd: 'pip3', args: [] },
    { cmd: 'pip', args: [] },
    { cmd: 'python3', args: ['-m', 'pip'] },
    { cmd: 'python', args: ['-m', 'pip'] },
  ];

  /**
   * Checks if a specific pip package is installed on the system.
   *
   * @param packageName The name of the package to check
   * @returns PipPackageInfo if the package is found
   * @throws SfError if pip is not found or package is not installed
   */
  public static async checkPackage(packageName: string): Promise<PipPackageInfo> {
    for (const pipCommand of this.PIP_COMMANDS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const packageInfo = await this.getPackageInfo(pipCommand, packageName);

        if (packageInfo) {
          return packageInfo;
        }
      } catch {
        continue;
      }
    }

    const pipAvailable = await this.isPipAvailable(this.PIP_COMMANDS);

    if (!pipAvailable) {
      throw new SfError(
        messages.getMessage('error.pipNotFound'),
        'PipNotFound',
        messages.getMessages('actions.pipNotFound')
      );
    }

    throw new SfError(
      messages.getMessage('error.packageNotInstalled', [packageName]),
      'PackageNotInstalled',
      messages.getMessages('actions.packageNotInstalled')
    );
  }

  /**
   * Checks PyPI for a newer version of the given package.
   * Returns PipUpdateInfo if a newer version is available, null if up-to-date or if the check fails.
   * Never throws — update checks are best-effort and must not block the user.
   *
   * @param packageInfo The installed package info returned by checkPackage
   */
  public static async checkForUpdate(packageInfo: PipPackageInfo): Promise<PipUpdateInfo | null> {
    try {
      const latestVersion = await this.fetchLatestPyPIVersion(packageInfo.name);

      if (!latestVersion || !this.isNewerVersion(packageInfo.version, latestVersion)) {
        return null;
      }

      return {
        packageName: packageInfo.name,
        installedVersion: packageInfo.version,
        latestVersion,
        pipCommand: packageInfo.pipCommand,
      };
    } catch {
      // Network errors, timeouts, parse failures — silently ignore
      return null;
    }
  }

  private static fetchLatestPyPIVersion(packageName: string): Promise<string | null> {
    return new Promise((resolve) => {
      const req = get(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, { timeout: 5000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body) as { info?: { version?: string } };
            resolve(data?.info?.version ?? null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    });
  }

  /**
   * Returns true if latestVersion is strictly newer than installedVersion.
   * Compares major.minor.patch numerically; pre-release suffixes are ignored.
   */
  private static isNewerVersion(installedVersion: string, latestVersion: string): boolean {
    const parse = (v: string): number[] =>
      v
        .split('.')
        .slice(0, 3)
        .map((part) => parseInt(part, 10) || 0);

    const installed = parse(installedVersion);
    const latest = parse(latestVersion);

    for (let i = 0; i < 3; i++) {
      const ins = installed[i] ?? 0;
      const lat = latest[i] ?? 0;
      if (lat !== ins) return lat > ins;
    }
    return false;
  }

  /**
   * Gets the package information for a specific pip command and package name.
   *
   * @param pipCommand The pip command descriptor to use
   * @param packageName The name of the package to check
   * @returns PipPackageInfo if package is found, null otherwise
   */
  private static async getPackageInfo(pipCommand: PipCommand, packageName: string): Promise<PipPackageInfo | null> {
    try {
      const { stdout } = await spawnAsync(pipCommand.cmd, [...pipCommand.args, 'show', packageName]);

      const nameMatch = stdout.match(/Name:\s+(.+)/);
      const versionMatch = stdout.match(/Version:\s+(.+)/);
      const locationMatch = stdout.match(/Location:\s+(.+)/);

      if (nameMatch && versionMatch && locationMatch) {
        return {
          name: nameMatch[1].trim(),
          version: versionMatch[1].trim(),
          location: locationMatch[1].trim(),
          pipCommand: pipCommand.cmd,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Checks if pip is available with any of the given commands.
   *
   * @param pipCommands List of pip command descriptors to try
   * @returns true if pip is available, false otherwise
   */
  private static async isPipAvailable(pipCommands: PipCommand[]): Promise<boolean> {
    for (const { cmd, args } of pipCommands) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await spawnAsync(cmd, [...args, '--version']);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

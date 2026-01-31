import * as os from 'os';
import * as path from 'path';

export function redactHomeDir(value: string, enabled: boolean): string {
  if (!enabled) {
    return value;
  }
  const home = os.homedir();
  if (!home) {
    return value;
  }

  const normalizedValue = value.replace(/\//g, path.sep);
  const normalizedHome = home.replace(/\//g, path.sep);

  const startsWithHome =
    process.platform === 'win32'
      ? normalizedValue.toLowerCase().startsWith(normalizedHome.toLowerCase())
      : normalizedValue.startsWith(normalizedHome);

  if (!startsWithHome) {
    return value;
  }

  const remainder = normalizedValue.slice(normalizedHome.length);
  return `~${remainder}`;
}

export function formatPathForExport(
  filePath: string,
  options: { includeFilePaths: boolean; redactHomeDir: boolean }
): string {
  const maybeRedacted = redactHomeDir(filePath, options.redactHomeDir);
  return options.includeFilePaths ? maybeRedacted : path.basename(maybeRedacted);
}

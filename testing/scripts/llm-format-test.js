const path = require('path');
const os = require('os');

const formatting = require('../../vscode-extension/out/llm/formatting');
const paths = require('../../vscode-extension/out/utils/paths');

const handoff = formatting.buildHandoffText({
  mode: 'compact',
  goal: 'Ship local mode',
  anchor: 'src/extension.ts:42',
  recentActions: ['Updated storage adapter', 'Added LLM config'],
  whatChanged: ['Touched files: extension.ts, localStorage.ts'],
  openQuestions: ['Any edge cases?'],
  nextStep: 'Run npm run compile',
  constraints: ['No secrets in output'],
  confidenceTag: 'mid-task'
});

if (!handoff.includes('Goal:')) {
  throw new Error('Handoff missing Goal section');
}
if (!handoff.includes('[Context]')) {
  throw new Error('Handoff missing Context header');
}

const home = os.homedir();
const samplePath = path.join(home, 'secret', 'file.txt');
const redacted = paths.redactHomeDir(samplePath, true);
if (!redacted.startsWith('~')) {
  throw new Error('Home dir was not redacted');
}

const basename = paths.formatPathForExport(samplePath, { includeFilePaths: false, redactHomeDir: true });
if (basename !== 'file.txt') {
  throw new Error('formatPathForExport did not return basename');
}

console.log('LLM formatting tests passed.');

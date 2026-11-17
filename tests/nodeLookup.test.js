import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('node lookup uses an installed fnm, nvm or asdf runtime', () => {
  const binary = path.join(os.tmpdir(), `node-lookup-check-${process.pid}`);
  execFileSync('swiftc', [
    '-parse-as-library',
    '-o', binary,
    'macos/AITaskRadar/NodeLookup.swift',
    'tests/nodeLookupCheck.swift'
  ], { stdio: 'inherit' });
  try {
    execFileSync(binary, { stdio: 'inherit' });
  } finally {
    fs.rmSync(binary, { force: true });
  }
});

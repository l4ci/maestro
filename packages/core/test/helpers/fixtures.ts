import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/forge/gitlab/__fixtures__');

/** Load a frozen GitLab REST/GraphQL JSON fixture by file name. */
export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as T;
}

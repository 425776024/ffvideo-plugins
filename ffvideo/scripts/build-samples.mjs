import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const directory = fileURLToPath(new URL('../assets/samples/', import.meta.url));
const recipes = JSON.parse(await readFile(join(directory, 'recipes.json'), 'utf8'));
if (process.platform !== 'darwin') throw new Error('Sample authoring uses macOS installed speech; release consumers use the prebuilt WAV files.');
for (const recipe of recipes) {
  const path = join(directory, recipe.id + '.wav');
  await promisify(execFile)('/usr/bin/say', ['-v', 'Tingting', '--file-format=WAVE', '--data-format=LEI16@24000', '-o', path, recipe.narration]);
  if ((await stat(path)).size < 20000) throw new Error('Speech service did not produce valid audio: ' + recipe.id);
  process.stderr.write(recipe.id + '\n');
}

// The demo in README.md, reproducible: builds a throwaway repository with one committed file and an
// edit someone regrets, then sends the guard the same JSON Claude Code sends before a Bash command,
// for each command an agent might reach for. Blocked commands never run; the safer path does.
// Run: node demo/run-demo.mjs   (needs git; touches nothing outside a new temp folder)
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../scripts/training-wheels.mjs', import.meta.url));
const repo = mkdtempSync(join(tmpdir(), 'training-wheels-demo-'));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const say = (s = '') => process.stdout.write(`${s}\n`);

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Demo');
git('config', 'user.email', 'demo@example.com');
writeFileSync(join(repo, 'notes.txt'), '# Trail notes\n- Ridge trail: steep, bring water.\n');
git('add', 'notes.txt');
git('commit', '-q', '-m', 'Add trail notes');
writeFileSync(join(repo, 'notes.txt'), '# Trail notes\nasdf asdf\n');

say('$ git status --short');
say(git('status', '--short'));
for (const command of ['git checkout -- notes.txt', 'git restore notes.txt', 'git reset --hard', 'git stash']) {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: repo };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, TRAINING_WHEELS: '' } });
  say();
  say(`agent wants to run: ${command}`);
  if (r.stdout) say(`  hook: deny. ${JSON.parse(r.stdout).systemMessage}`);
  else say('  hook: no objection, so the command runs');
}
say();
say('$ git stash');
say(git('stash'));
say('$ cat notes.txt');
say(readFileSync(join(repo, 'notes.txt'), 'utf8').trimEnd());
say('$ git stash pop    # and the edit is back, if it was wanted after all');
git('stash', 'pop');
say(readFileSync(join(repo, 'notes.txt'), 'utf8').trimEnd());
rmSync(repo, { recursive: true, force: true });

// Run: npm test   (Node's built-in runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, splitCommands } from '../scripts/training-wheels.mjs';

const HOOK = fileURLToPath(new URL('../scripts/training-wheels.mjs', import.meta.url));

// A pretend repository: these names are branches or commits, these are files on disk.
const ctx = {
  cwd: '.',
  isRef: (name) => ['main', 'feature', 'HEAD', 'HEAD~1', 'origin/main'].includes(name),
  isPath: (name) => ['notes.txt', 'src', 'src/app.js', '.'].includes(name),
};

const BLOCKED = {
  'force-push': ['git push --force', 'git push -f origin main', 'git push origin main --force', 'git push -uf origin feature',
    'git push --force-with-lease', 'git push origin +main', 'FOO=1 git push -f',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push -f', '/usr/bin/git push --force'],
  'remote-delete': ['git push --delete origin old', 'git push origin :old', 'git push -d origin old', 'git push --mirror', 'git push --prune origin'],
  'reset-hard': ['git reset --hard', 'git reset --hard HEAD~1', 'git -C ../repo reset --hard', 'cd repo && git reset --hard origin/main',
    'git -c core.pager=cat reset --hard',
    'bash -c "git reset --hard"', 'powershell -Command "git status; git reset --hard"', 'cmd /c git reset --hard'],
  'branch-force-delete': ['git branch -D feature', 'git branch --delete --force feature', 'git branch -df feature'],
  'branch-force': ['git branch -f feature main', 'git branch -M feature', 'git branch -C feature copy'],
  clean: ['git clean -f', 'git clean -fd', 'git clean -xdf', 'sudo git clean --force'],
  'checkout-files': ['git checkout -- notes.txt', 'git checkout .', 'git checkout notes.txt', 'git checkout HEAD notes.txt',
    'git checkout main -- src/app.js'],
  'checkout-force': ['git checkout -f main', 'git checkout --force feature'],
  'checkout-reset-branch': ['git checkout -B feature'],
  restore: ['git restore notes.txt', 'git restore .', 'git restore --worktree --staged notes.txt', 'git restore -SW notes.txt',
    'git restore --source=HEAD~1 notes.txt'],
  'switch-discard': ['git switch --discard-changes main', 'git switch -f main'],
  'switch-force-create': ['git switch -C feature'],
  'stash-drop': ['git stash drop', 'git stash clear'],
  rebase: ['git rebase main', 'git rebase -i HEAD~3', 'git pull --rebase=false && git rebase origin/main'],
  amend: ['git commit --amend -m "better message"', 'git commit --amend --no-edit'],
  'rm-force': ['git rm -f notes.txt'],
  'rewrite-history': ['git filter-branch --tree-filter "rm -f secrets.txt" HEAD', 'git filter-repo --path secrets.txt --invert-paths'],
  'reflog-expire': ['git reflog expire --expire=now --all'],
  'prune-now': ['git gc --prune=now', 'git prune'],
  'update-ref-delete': ['git update-ref -d refs/heads/feature'],
  'worktree-force': ['git worktree remove --force ../wt'],
  'repo-delete': ['gh repo delete desertcache/example --yes'],
  'delete-dot-git': ['rm -rf .git', 'rm -rf ./.git/', 'Remove-Item -Recurse -Force .git', 'rd /s /q .git'],
};

const ALLOWED = [
  'git status', 'git add -A', 'git add notes.txt', 'git commit -m "Fix the typo in the intro"', 'git diff', 'git log --oneline -5',
  'git switch -c fix-typo', 'git checkout -b fix-typo', 'git checkout main', 'git checkout -b fix origin/main', 'git switch main',
  'git push -u origin fix-typo', 'git push', 'git pull', 'git fetch origin', 'git merge main',
  'git restore --staged notes.txt', 'git reset --soft HEAD~1', 'git reset HEAD~1', 'git reset notes.txt',
  'git branch -d fix-typo', 'git branch', 'git clean -n', 'git clean -fn', 'git stash', 'git stash pop', 'git stash list',
  'git rebase --abort', 'bash -c "git status"', 'git rm notes.txt', 'git gc', 'gh pr create --fill', 'gh pr view', 'rm notes.txt', 'npm test',
  // Mentioning a dangerous command is not running it.
  'git commit -m "Never run git reset --hard; use git stash"', "echo 'git push --force'", 'grep -rn "git clean -f" docs',
  'git log --grep="rebase"',
  "git commit -m \"$(cat <<'EOF'\nDocs: why we never git push --force\n\nIt rewrites shared history.\nEOF\n)\"",
  "cat > NOTES.md <<'EOF'\ngit push --force\nrm -rf .git\nEOF\ngit add NOTES.md",
];

for (const [rule, commands] of Object.entries(BLOCKED)) {
  test(`blocks ${rule}`, () => {
    for (const c of commands) assert.equal(check(c, ctx)?.rule, rule, c);
  });
}

test('lets everyday commands through', () => {
  for (const c of ALLOWED) assert.equal(check(c, ctx), null, c);
});

test('a heredoc body is text, and the command after it still counts', () => {
  assert.equal(check("cat > a.md <<'EOF'\ngit reset --hard\nEOF\ngit reset --hard", ctx)?.rule, 'reset-hard');
  assert.equal(check('cat > a.md <<-EOF\n\tgit reset --hard\n\tEOF\ngit status', ctx), null);
});

test('splits commands at separators but never inside quotes', () => {
  assert.deepEqual(splitCommands('git add -A && git commit -m "a; b && c" | cat'), [['git', 'add', '-A'], ['git', 'commit', '-m', 'a; b && c'], ['cat']]);
  assert.deepEqual(splitCommands("echo 'it''s'; git status"), [['echo', 'its'], ['git', 'status']]);
  assert.deepEqual(splitCommands('echo $(git reset --hard)'), [['echo'], ['git', 'reset', '--hard']]);
});

/** @param {object} input @param {Record<string, string>} [env] */
function runHook(input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('as a hook: a blocked command gets a deny decision with its reason', () => {
  const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd: '.' }, { TRAINING_WHEELS: '' });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /git reset --hard.*git stash/);
  assert.match(out.systemMessage, /^training-wheels stopped `git reset --hard`/);
});

test('as a hook: an allowed command, or the off switch, prints nothing', () => {
  const allowed = runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { TRAINING_WHEELS: '' });
  assert.deepEqual([allowed.code, allowed.out], [0, '']);
  const off = runHook({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, { TRAINING_WHEELS: 'off' });
  assert.deepEqual([off.code, off.out], [0, '']);
});

test('as a hook: PowerShell commands are checked too', () => {
  const r = runHook({ tool_name: 'PowerShell', tool_input: { command: 'git push --force; Remove-Item x' } }, { TRAINING_WHEELS: '' });
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
});

test('as a hook: input it cannot read lets the command through, with a note', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, TRAINING_WHEELS: '' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /could not check this command/);
});

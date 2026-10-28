// Run: npm test   (Node's built-in runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, splitCommands } from '../scripts/training-wheels.mjs';

const HOOK = fileURLToPath(new URL('../scripts/training-wheels.mjs', import.meta.url));

// A pretend repository: these names are branches or commits, these are files on disk, these are aliases.
const ALIASES = { yolo: 'push --force', st: 'status' };
const ctx = {
  cwd: '.',
  isRef: (name) => ['main', 'feature', 'HEAD', 'HEAD~1', 'origin/main'].includes(name),
  isPath: (name) => ['notes.txt', 'src', 'src/app.js', '.'].includes(name),
  alias: (name) => ALIASES[name] ?? null,
};
const ps = { ...ctx, shell: 'powershell' };

// The commands a first pull request needs: all on the list.
const ALLOWED = [
  'git status', 'git status -sb', 'git diff', 'git diff --staged', 'git log --oneline -5', 'git show HEAD', 'git blame src/app.js',
  'git add -A', 'git add notes.txt', 'git add .', 'git commit -m "Fix the typo in the intro"', 'git commit -m "Fix the typo" -m "Why it matters"',
  'git commit -am "Fix the typo"', 'git commit -F msg.txt', 'git switch -c fix-typo', 'git checkout -b fix-typo', 'git checkout -b fix origin/main',
  'git switch main', 'git checkout main', 'git push -u origin fix-typo', 'git push', 'git push --follow-tags', 'git push --dry-run',
  'git pull', 'git pull --ff-only', 'git fetch origin', 'git fetch --prune', 'git merge main', 'git merge --abort',
  'git restore --staged notes.txt', 'git restore --staged .', 'git reset --soft HEAD~1', 'git reset HEAD~1', 'git reset notes.txt',
  'git branch', 'git branch fix-typo', 'git branch -vv', 'git branch --show-current', 'git clean -n', 'git clean -nd',
  'git stash', 'git stash push -m "wip"', 'git stash pop', 'git stash list', 'git rebase --abort', 'git rebase --abo',
  'git rm notes.txt', 'git mv a.txt b.txt', 'git remote -v', 'git remote get-url origin', 'git tag', 'git tag -a v1 -m "First release"',
  'git reflog', 'git init', 'git clone https://github.com/octo/repo.git', 'git config --global user.name "Sam Bates"', 'git config user.email',
  'git config --get alias.st', 'git -C ../repo status', 'git -c color.ui=always log', 'git --version', 'git help commit',
  'gh pr create --fill', 'gh pr view',
  // the exact 2>&1 form names no file and takes no word, so it stays allowed
  'git status 2>&1', 'git log --oneline 2>&1 | head -5',
  // commands that aren't git pass through to Claude Code's own permissions, $ and backslashes included
  'npm test', 'bash scripts/build.sh', 'powershell -NoProfile -File build.ps1', 'echo "$HOME"', 'ls $HOME', 'ls *.md', 'rm notes.txt',
  'command -v git', "cat > notes.md <<'EOF'\nhello\nEOF",
  // mentioning a dangerous command is not running it
  'git commit -m "Never run git reset --hard; use git stash"', "echo 'git push --force'", 'grep -rn "git clean -f" docs',
  'git log --grep="rebase"', "git log --format='%h {a,b} $x'", "git log -- 'src/{a,b}'",
];

// The classic ways to lose work get their own reason, whatever the spelling.
const CLASSIC = {
  'force-push': ['git push --force', 'git push -f origin main', 'git push origin main --force', 'git push -uf origin feature', 'git push -fq',
    'git push --force-with-lease', 'git push origin +main', '/usr/bin/git push --force', 'git push --forc', 'git push --force-with-lea',
    'git push --fo origin main', 'git push --for"ce"', "git push '--force'", 'sudo git push -f', 'timeout 30 git push --force',
    'nice -n 5 git push -f', 'nohup git push --force', 'exec git push -f', 'command git push -f', 'git push 2>&1 --force',
    // generous: anything that looks like a force is refused; with -o it's refused by the list anyway
    'git push -o --force origin main'],
  'remote-delete': ['git push --delete origin old', 'git push origin :old', 'git push -d origin old', 'git push --mirror', 'git push --prune origin',
    'git push --del origin old'],
  'reset-hard': ['git reset --hard', 'git reset --hard HEAD~1', 'git -C ../repo reset --hard', 'cd repo && git reset --hard origin/main',
    'git reset --har', '(git reset --hard)', 'git --no-pager reset -q --hard', 'git reset --keep HEAD~1'],
  'branch-delete': ['git branch -D feature', 'git branch -d fix-typo', 'git branch --delete --force feature', 'git branch -df feature'],
  'branch-force': ['git branch -f feature main', 'git branch -M feature', 'git branch -C feature copy', 'git branch --forc feature main'],
  clean: ['git clean -f', 'git clean -fd', 'git clean -xdf', 'sudo git clean --force'],
  'checkout-files': ['git checkout -- notes.txt', 'git checkout .', 'git checkout notes.txt', 'git checkout HEAD notes.txt',
    'git checkout main -- src/app.js'],
  'checkout-force': ['git checkout -f main', 'git checkout --force feature'],
  'checkout-reset-branch': ['git checkout -B feature', 'git checkout -qB feature'],
  restore: ['git restore notes.txt', 'git restore .', 'git restore --worktree --staged notes.txt', 'git restore -SW notes.txt',
    'git restore --source=HEAD~1 notes.txt', 'git restore -s HEAD notes.txt'],
  'switch-discard': ['git switch --discard-changes main', 'git switch -f main', 'git switch --discard main'],
  'switch-force-create': ['git switch -C feature', 'git switch --force-c feature'],
  'stash-drop': ['git stash drop', 'git stash clear'],
  rebase: ['git rebase main', 'git rebase -i HEAD~3', 'git rebase --exec "--abort" main'],
  amend: ['git commit --amend -m "better message"', 'git commit --amend --no-edit', 'git commit --am -m "x"', 'git commit -m "x" --amend',
    'git commit -cm --amend', 'git commit -m --amend'],
  'rm-force': ['git rm -f notes.txt'],
  'rewrite-history': ['git filter-branch --tree-filter "rm -f secrets.txt" HEAD', 'git filter-repo --path secrets.txt --invert-paths'],
  'repo-delete': ['gh repo delete desertcache/example --yes'],
  'delete-dot-git': ['rm -rf .git', 'rm -rf ./.git/', 'Remove-Item -Recurse -Force .git'],
};

// Everything else in git that a first pull request doesn't need.
const NOT_ON_LIST = [
  'git grep -O vim foo', 'git grep --open-files-in-pager=vim foo', 'git archive --exec=x HEAD', 'git gc', 'git gc --prune=now',
  'git gc --prune now', 'git prune', 'git worktree remove --force ../wt', 'git worktree remove -ff ../wt', 'git reflog expire --expire=now --all',
  'git update-ref -d refs/heads/feature', 'git submodule foreach "git reset --hard"', 'git bisect run make', 'git difftool -x "rm -rf ."',
  'git mergetool --tool-cmd=x', 'git cherry-pick abc123', 'git revert HEAD', 'git am patch', 'git apply x.patch', 'git tag -d v1',
  'git add -f .env', 'git commit', 'git commit -Zm "x"', 'git commit --no-verify -m "x"', 'git merge --no-verify main', 'git merge -X theirs main',
  'git fetch --upload-pack=x origin', 'git fetch origin +main:main', 'git pull --rebase', 'git pull --upload-pack=x', 'git push --receive-pack=x',
  'git push --exec=x', 'git push --no-verify', 'git remote add evil https://x', 'git config core.editor vim', 'git config alias.yolo "push --force"',
  'git config --global alias.st status', 'git diff --output=src/app.js', 'git yolo', 'git co main', 'git lfs install', 'git --exec-path=/tmp status',
  'git --git-dir=x status', '/usr/lib/git-core/git-push --force', 'gh api -X DELETE repos/a/b',
];

// What the guard can't read exactly is refused, not parsed.
const CANNOT_READ = [
  // this round: redirections that can carry a word, any backslash, line breaks, wildcards, splatting, variable cmdlets
  'git push >& /dev/null --force', 'git status &> log.txt', 'git status |& cat', 'git push <& x --force', 'git push --for\\ce',
  '"C:\\Program Files\\Git\\cmd\\git.exe" push -f', "git commit -m 'C:\\temp'", 'git push origin main\r--force', 'git status\ngit log',
  "cat > notes.md <<'EOF'\ngit push --force\nEOF", 'git push --forc?', 'git push -[f]', 'git add *.js', '/usr/bin/gi? push',
  'git push @extra', 'Set-Variable a "--force"; git push @a', 'sv a x', 'New-Variable -Name a -Value x', 'Set-Alias g git',
  // earlier rounds: wrappers, shells and interpreters that carry a command
  'bash -c "git reset --hard"', 'bash -xc "git push --force"', 'sh -euc "git reset --hard"', 'powershell -Command "git status"',
  'powershell -Comm "git push --force"', 'pwsh -Com "git push --force"', 'powershell -EncodedCommand ZwBpAHQA', 'powershell -e ZwBp',
  'cmd /c git reset --hard', 'eval "git push --force"', 'iex "git reset --hard"', 'Invoke-Expression "git reset --hard"',
  'Start-Process git -ArgumentList "push","--force"', 'node -e "x"', 'python -c "import os"', 'time git status',
  'echo "git push --force" | bash', 'bash < cmds.txt', 'bash -s', 'source /dev/stdin <<< "x"', 'export GIT_EDITOR="vim"',
  'env -S "git push --force"', 'env -iS "git push --force"', 'env -i git reset --hard', 'echo feature | xargs git branch -D', 'xargs -I{} git {}',
  'xargs sudo git push', 'xargs --max-chars 100 git push', 'xargs --process-slot-var V git push', 'xargs --max-c 100 git', 'ls | xargs echo',
  'sudo -u bob git clean -f', 'timeout -s KILL 5 git push', 'nice -10 git push', 'sudo npm test', 'timeout 60 npm test',
  // shell variables, substitutions, braces, process substitution, variables in front of git
  "git push $'--force'", 'F=--force; git push $F', 'git push "$F"', 'git push ${F}', 'git push --{force,x}', 'git push "$(echo --force)"',
  'git push $(true) --force', 'git push `echo --force`', 'git $SUB --force', 'git commit -m $MSG', 'git -C "$HOME/repo" status', '$cmd push --force',
  'echo "$(git push --force)"', '{ git push --force; }', 'diff <(git log) <(git log main)', 'FOO=1 git push -f',
  'git -c core.pager="git reset --hard" log', 'git -c alias.p="push --force" p',
  "git commit -m \"$(cat <<'EOF'\nA message\nEOF\n)\"",
];

test('the commands a first pull request needs are on the list', () => {
  for (const c of ALLOWED) assert.equal(check(c, ctx), null, c);
});

for (const [rule, commands] of Object.entries(CLASSIC)) {
  test(`the classic way to lose work gets its reason: ${rule}`, () => {
    for (const c of commands) assert.equal(check(c, ctx)?.rule, rule, c);
  });
}

test('everything else in git is off the list', () => {
  for (const c of NOT_ON_LIST) assert.equal(check(c, ctx)?.rule, 'not-on-list', c);
});

test('what the guard cannot read exactly is refused', () => {
  for (const c of CANNOT_READ) assert.equal(check(c, ctx)?.rule, 'cannot-read', c);
});

test('PowerShell: a backtick escapes, @ splats, and a computed command name is refused', () => {
  for (const c of ['git push --for`ce', 'git push @extra', "& ('g'+'it') push --force", 'sv a x; git push @a']) {
    assert.equal(check(c, ps)?.rule, 'cannot-read', c);
  }
  assert.equal(check('git push --force; Remove-Item x', ps)?.rule, 'force-push');
  assert.equal(check('Get-Content .\\README.md', ps), null);
});

test('splits commands at separators but never inside quotes', () => {
  assert.deepEqual(splitCommands('git add -A && git commit -m "a; b && c" | cat'), [['git', 'add', '-A'], ['git', 'commit', '-m', 'a; b && c'], ['cat']]);
  assert.deepEqual(splitCommands("echo 'it''s'; git status"), [['echo', 'its'], ['git', 'status']]);
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

test('as a hook: off-list and unreadable commands say what to do instead', () => {
  const off = runHook({ tool_name: 'Bash', tool_input: { command: 'git gc' } }, { TRAINING_WHEELS: '' });
  assert.match(JSON.parse(off.out).systemMessage, /isn't on the training-wheels list.*ask a reviewer/);
  const unread = runHook({ tool_name: 'Bash', tool_input: { command: 'xargs git' } }, { TRAINING_WHEELS: '' });
  assert.match(JSON.parse(unread.out).systemMessage, /can't read safely what it would run.*written out in full/);
});

test('as a hook: an allowed command, or the off switch, prints nothing', () => {
  const allowed = runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { TRAINING_WHEELS: '' });
  assert.deepEqual([allowed.code, allowed.out], [0, '']);
  const off = runHook({ tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, { TRAINING_WHEELS: 'off' });
  assert.deepEqual([off.code, off.out], [0, '']);
});

test('as a hook: the PowerShell tool is read as PowerShell', () => {
  const r = runHook({ tool_name: 'PowerShell', tool_input: { command: 'git push --for`ce' } }, { TRAINING_WHEELS: '' });
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
});

test('as a hook: input it cannot read lets the command through, with a note', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, TRAINING_WHEELS: '' } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /could not check this command/);
});

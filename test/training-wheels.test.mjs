// Run: npm test   (Node's built-in runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, splitCommands } from '../scripts/training-wheels.mjs';

const HOOK = fileURLToPath(new URL('../scripts/training-wheels.mjs', import.meta.url));

// A pretend repository: these names are branches or commits, these are files on disk, these are aliases.
const ALIASES = { yolo: 'push --force', nuke: '!git reset --hard', st: 'status' };
const ctx = {
  cwd: '.',
  isRef: (name) => ['main', 'feature', 'HEAD', 'HEAD~1', 'origin/main'].includes(name),
  isPath: (name) => ['notes.txt', 'src', 'src/app.js', '.'].includes(name),
  alias: (name) => ALIASES[name] ?? null,
};

// Plain git commands get the specific reason.
const BLOCKED = {
  'force-push': ['git push --force', 'git push -f origin main', 'git push origin main --force', 'git push -uf origin feature', 'git push -fq',
    'git push --force-with-lease', 'git push origin +main', '"C:\\Program Files\\Git\\cmd\\git.exe" push -f', '/usr/bin/git push --force',
    // git accepts any unambiguous abbreviation of a long option
    'git push --forc', 'git push --force-with-lea', 'git push --fo origin main',
    // quotes the shell removes
    'git push --for"ce"', "git push '--force'",
    // the wrappers the guard strips exactly
    'sudo git push -f', 'timeout 30 git push --force', 'nice -n 5 git push -f', 'nice git push -f', 'nohup git push --force', 'exec git push -f',
    'command git push -f'],
  'remote-delete': ['git push --delete origin old', 'git push origin :old', 'git push -d origin old', 'git push --mirror', 'git push --prune origin',
    'git push --del origin old'],
  'reset-hard': ['git reset --hard', 'git reset --hard HEAD~1', 'git -C ../repo reset --hard', 'cd repo && git reset --hard origin/main',
    'git -c color.ui=never reset --hard', 'git reset --har', '(git reset --hard)', 'git --no-pager reset -q --hard'],
  'branch-force-delete': ['git branch -D feature', 'git branch --delete --force feature', 'git branch -df feature'],
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
  rebase: ['git rebase main', 'git rebase -i HEAD~3', 'git pull --rebase=false && git rebase origin/main', 'git rebase --exec "--abort" main'],
  amend: ['git commit --amend -m "better message"', 'git commit --amend --no-edit', 'git commit --am -m "x"', 'git commit -m "x" --amend',
    // -c takes a value, so in -cm the m is that value and --amend after it is an option
    'git commit -am x --amend', 'git commit -cm --amend'],
  'rm-force': ['git rm -f notes.txt'],
  'rewrite-history': ['git filter-branch --tree-filter "rm -f secrets.txt" HEAD', 'git filter-repo --path secrets.txt --invert-paths'],
  'reflog-expire': ['git reflog expire --expire=now --all'],
  'prune-now': ['git gc --prune=now', 'git prune', 'git gc --prun=all'],
  'update-ref-delete': ['git update-ref -d refs/heads/feature'],
  'worktree-force': ['git worktree remove --force ../wt'],
  'repo-delete': ['gh repo delete desertcache/example --yes'],
  'delete-dot-git': ['rm -rf .git', 'rm -rf ./.git/', 'Remove-Item -Recurse -Force .git', 'rd /s /q .git'],
  // Anything that could carry or hide a command is refused, not parsed.
  'cannot-read': [
    // shells, interpreters and other programs that run a command given to them
    'bash -c "git reset --hard"', 'bash -xc "git push --force"', 'sh -euc "git reset --hard"', 'bash -o pipefail -c "git reset --hard"',
    'powershell -Command "git status; git reset --hard"', 'powershell -Comm "git push --force"', 'pwsh -Com "git push --force"',
    'powershell -NoProfile "git push --force"', 'powershell -EncodedCommand ZwBpAHQA', 'powershell -e ZwBpAHQA', 'pwsh -ec ZwBpAHQA',
    'powershell -Command -', 'cmd /c git reset --hard', 'cmd /C "git reset --hard"', 'cmd < cmds.txt',
    'eval "git push --force"', 'iex "git reset --hard"', 'Invoke-Expression "git reset --hard"', 'Start-Process git -ArgumentList "push","--force"',
    'node -e "require(\'child_process\').execSync(\'git push -f\')"', 'python -c "import os"', 'time git status',
    'echo "git push --force" | bash', 'bash < cmds.txt', 'bash -s', 'bash <<< "git reset --hard"', 'source /dev/stdin <<< "git push -f"',
    'bash /dev/stdin', 'export GIT_EDITOR="git reset --hard"',
    // env and xargs in every form, including this round's four (xargs through wrappers, long options and their
    // abbreviations, env -S inside a cluster, and env -S escapes)
    'env -S "git push --force"', 'env -S"git push" --force', 'env -i -S "git -C . push -f"', 'env --split-string="git reset --hard"',
    'env -iS "git push --force"', 'env -S "git\\ push --force"', 'env -i git reset --hard', 'env GIT_CONFIG_PARAMETERS="\'alias.x=push --force\'" git x',
    'echo feature | xargs git branch -D', 'xargs -I {} git branch -D {}', 'echo "push --force" | xargs git', 'xargs -I{} git {}',
    'xargs -a args.txt git', 'ls | xargs rm -rf', 'xargs -0 bash -c', 'xargs sudo git push', 'xargs timeout 5 git push',
    'xargs --max-chars 100 git push', 'xargs --process-slot-var V git push', 'xargs --max-c 100 git', 'ls | xargs echo',
    // wrappers the guard doesn't strip exactly, and anything but git, gh or rm after one
    'sudo -u bob git clean -f', 'timeout -s KILL 5 git push', 'nice -10 git push', 'sudo npm test', 'timeout 60 npm test',
    // a shell variable, command substitution, backtick, escape, brace or process substitution where it could hide a command
    "git push $'--force'", "git push $'\\x2d\\x2dforce'", 'git push --for\\ce', 'F=--force; git push $F', 'git push "$F"', 'git push ${F}',
    'git push --{force,x}', 'git push "$(echo --force)"', 'git push $(printf -- --force)', 'git push `echo --force`', 'git push $(true) --force',
    'git $SUB --force', 'git commit -m $MSG', 'git push -m "$(echo --force)"', 'git status -C "$X"', 'git stash push -m "$X"',
    'git -c "user.name=$N" status', 'git -C "$HOME/repo" reset --hard', '$cmd push --force', 'echo "$(git push --force)"', '{ git push --force; }',
    'Get-ChildItem | ForEach-Object { git branch -D $_ }', 'diff <(git log) <(git log main)', 'FOO=1 git push -f',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0="push --force" git x',
    "git commit -m \"$(cat <<'EOF'\nA message\nEOF\n)\"", 'cat <<EOF | git commit -F -\n$(git push --force)\nEOF',
    // git's own ways of running another command, aliases, and settings that name a program
    'git yolo', 'git nuke', 'git -c alias.p="push --force" p', 'git config alias.yolo "push --force"', 'git config --global alias.st status',
    'git -c core.pager="git reset --hard" log', 'git config core.editor vim', 'git --exec-path=/tmp status',
    'git submodule foreach "git reset --hard"', 'git bisect run make', 'git difftool -x "rm -rf ."',
    // a short-option letter the guard doesn't know could take a value and change how the rest reads
    'git commit -Zm "x"'],
};

const ALLOWED = [
  'git status', 'git add -A', 'git add notes.txt', 'git commit -m "Fix the typo in the intro"', 'git commit -m "Fix the typo" -m "Why it matters"',
  'git diff', 'git log --oneline -5', 'git switch -c fix-typo', 'git checkout -b fix-typo', 'git checkout main', 'git checkout -b fix origin/main',
  'git switch main', 'git push -u origin fix-typo', 'git push', 'git push --follow-tags', 'git push --dry-run', 'git pull', 'git fetch origin',
  'git merge main', 'git restore --staged notes.txt', 'git restore --staged .', 'git reset --soft HEAD~1', 'git reset HEAD~1', 'git reset notes.txt',
  'git branch -d fix-typo', 'git branch', 'git clean -n', 'git clean -fn', 'git clean -f --dry-run', 'git stash', 'git stash pop', 'git stash list',
  'git rebase --abort', 'git rebase --abo', 'git rm notes.txt', 'git gc', 'gh pr create --fill', 'gh pr view', 'rm notes.txt', 'npm test',
  'bash scripts/build.sh', 'powershell -NoProfile -File build.ps1', 'git co main', 'git lfs install', 'git -C ../repo status',
  'git -c color.ui=always log', 'git config --global user.name "Sam Bates"', 'git config user.email', 'git config --get alias.st',
  'command -v git',
  // An option that takes a value takes the next word, as git does: here --amend is the message and --force a push option.
  'git commit -m --amend', 'git push -o --force origin main',
  // $ in another program's arguments can't change what git runs.
  'echo "$HOME"', 'ls $HOME',
  // Mentioning a dangerous command is not running it.
  'git commit -m "Never run git reset --hard; use git stash"', "echo 'git push --force'", 'grep -rn "git clean -f" docs',
  'git log --grep="rebase"', "git log --format='%h {a,b} $x'", "git log -- 'src/{a,b}'",
  "git commit -F - <<'EOF'\nA message that mentions $(git push --force)\nEOF",
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

test('as a hook: a command it cannot read is refused with a way forward', () => {
  const r = runHook({ tool_name: 'Bash', tool_input: { command: 'xargs git' } }, { TRAINING_WHEELS: '' });
  assert.match(JSON.parse(r.out).systemMessage, /can't read safely what it would run.*run the command itself/);
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

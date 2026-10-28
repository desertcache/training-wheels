# Training wheels for a first pull request

A Claude Code plugin for someone making their first pull request. A skill walks them through
branch, commit, pull request and merge in plain words, and a hook keeps the agent to the git
commands a first pull request needs, so nothing it does can't be taken back.

## The rule

**Everything you do here can be undone.**

People who are new to git are mostly afraid of one thing: breaking something they can't fix. The
fear is reasonable, because a handful of git commands really do throw work away for good. Take that
handful off the table and the promise becomes true: any step can be reversed, so it's safe to try
things.

When an AI agent is the one typing the commands, the promise has to be enforced, not just said. So
the hook runs before every shell command the agent wants to run. A git command runs only if it's on
a short list of what a first pull request needs. The classic ways to lose work get refused with a
one-sentence reason and a safer command; anything else in git gets "not on the training-wheels
list; ask a reviewer".

## What it costs

It refuses commands experienced people use every day: force pushes, hard resets, rebases, amended
commits, branch deletes, and most of git besides. If you know what you're doing, you'll run into it.
That's the trade: a beginner can't lose work by accident, and an expert has to step around the
guard on purpose. Two ways to do that:

- **Run the command yourself in a terminal.** The hook only stops the agent, never you.
- **Turn it off for a session.** Start Claude Code with `TRAINING_WHEELS=off` in its environment:
  `TRAINING_WHEELS=off claude` in bash, or `$env:TRAINING_WHEELS = 'off'; claude` in PowerShell.

## Allowed commands

Each command may use only the options listed; any other option puts it off the list. Long options
can be abbreviated, as git allows. `[no-]` means both forms.

| Command | Allowed options and arguments |
|---|---|
| git's own, before the command | `-C <path>`, `-c <setting>` (only the settings `git config` may set, below), `--no-pager`, `-P`, `--version`, `--help` |
| `git status` | `-s` `-b` `-v` `-z`, `--short`, `--branch`, `--porcelain`, `--long`, `--verbose`, `--untracked-files`, `--ignored`, `--show-stash`, `--[no-]ahead-behind`, `--[no-]renames`, `--[no-]column`, `--null`; paths |
| `git diff` | `-U <n>`, `-w` `-b` `-R` `-p` `-z`, `--unified`, `--diff-filter`, `--staged`, `--cached`, `--stat`, `--numstat`, `--shortstat`, `--name-only`, `--name-status`, `--word-diff`, `--color-words`, `--[no-]color`, `--ignore-all-space`, `--ignore-space-change`, `--ignore-blank-lines`, `--exit-code`, `--quiet`, `--check`, `--minimal`, `--patience`, `--histogram`, `--[no-]patch`, `--summary`, `--merge-base`, `--relative`; commits and paths. Not `--output`, which overwrites a file, or `--ext-diff`, which starts a program |
| `git log` | `-n <n>`, `-<n>`, `-S <text>`, `-G <regex>`, `-p` `-i`, `--max-count`, `--skip`, `--since`, `--after`, `--until`, `--before`, `--author`, `--committer`, `--grep`, `--date`, `--oneline`, `--graph`, `--[no-]decorate`, `--all`, `--branches`, `--tags`, `--remotes`, `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`, `--[no-]patch`, `--follow`, `--reverse`, `--first-parent`, `--[no-]merges`, `--abbrev-commit`, `--format`, `--pretty`, `--[no-]color`, `--left-right`, `--word-diff`, `--relative-date`, `--date-order`, `--topo-order`, `--regexp-ignore-case`; commits and paths |
| `git show` | `-U <n>`, `-<n>`, `-p` `-s` `-q` `-w`, `--date`, `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`, `--oneline`, `--format`, `--pretty`, `--[no-]patch`, `--abbrev-commit`, `--[no-]color`, `--word-diff`, `--quiet`, `--summary`; commits and paths |
| `git blame` | `-L <range>`, `-w` `-e` `-s` `-l`, `--date`, `--show-email`, `--show-name`, `--show-number`, `--porcelain`, `--line-porcelain`, `--root`, `--show-stats`; a file |
| `git shortlog` | `-s` `-n` `-e`, `--summary`, `--numbered`, `--email`, `--all`, `--no-merges` |
| `git ls-files` | `-m` `-o` `-c` `-d` `-s` `-u` `-z` `-t`, `--modified`, `--others`, `--cached`, `--deleted`, `--stage`, `--unmerged`, `--exclude-standard`, `--full-name`, `--error-unmatch`, `--directory`, `--no-empty-directory`, `--eol`; paths |
| `git ls-remote` | `-q` `-t`, `--sort <key>`, `--heads`, `--branches`, `--tags`, `--refs`, `--quiet`, `--get-url`, `--symref`; a remote and patterns. Not `--upload-pack`, which starts a program |
| `git rev-parse` | `-q`, `--show-toplevel`, `--abbrev-ref`, `--short`, `--git-dir`, `--git-common-dir`, `--is-inside-work-tree`, `--is-inside-git-dir`, `--verify`, `--quiet`, `--symbolic-full-name`, `--show-prefix`, `--show-cdup`, `--absolute-git-dir`; names |
| `git describe` | `--tags`, `--all`, `--always`, `--abbrev`, `--dirty`, `--long`, `--contains`, `--exact-match`, `--first-parent`; commits |
| `git grep` | `-e <pattern>`, `-A` `-B` `-C <n>`, `-<n>`, `-n` `-i` `-w` `-l` `-L` `-c` `-v` `-E` `-F` `-I` `-h` `-H`, `--max-depth`, `--context`, `--after-context`, `--before-context`, `--line-number`, `--ignore-case`, `--word-regexp`, `--files-with-matches`, `--files-without-match`, `--count`, `--invert-match`, `--extended-regexp`, `--fixed-strings`, `--basic-regexp`, `--cached`, `--untracked`, `--break`, `--heading`, `--full-name`, `--only-matching`, `--column`, `--[no-]color`, `--all-match`, `--and`, `--or`, `--not`; patterns and paths. Not `-O`, which starts a program |
| `git help` | `-a` `-g`, `--all`, `--guides`; a command name |
| `git version` | `--build-options` |
| `git add` | `-A` `-u` `-v` `-n` `-N`, `--all`, `--update`, `--verbose`, `--dry-run`, `--intent-to-add`; paths. Not `-f`, which adds ignored files such as secrets |
| `git commit` | Must have a message: `-m <msg>` (one per paragraph) or `-F <file>`; also `-a`, `--message`, `--file`, `--all`; paths |
| `git switch` | `<branch>`, or `-c <new-branch> [<start>]`; `-q` `-t`, `--create`, `--quiet`, `--[no-]track`, `--[no-]guess` |
| `git checkout` | `<branch>`, or `-b <new-branch> [<start>]`; `-q` `-t`, `--quiet`, `--[no-]track` |
| `git branch` | listing, or `<new-branch> [<start>]`; `-u <upstream>`, `-a` `-r` `-l` `-v`, `--set-upstream-to`, `--sort`, `--format`, `--points-at`, `--all`, `--remotes`, `--list`, `--verbose`, `--show-current`, `--[no-]merged`, `--[no-]contains`, `--[no-]color` |
| `git restore` | `-S` or `--staged` (required: it only unstages), `-q`, `--quiet`; files |
| `git reset` | `--soft`, `--mixed`, `-q`, `--quiet`; a commit or files (it takes a commit back and keeps every change) |
| `git stash` | `push` with `-m <msg>` `-u` `-q`, `--message`, `--include-untracked`, `--quiet`; `pop`, `apply`, `list`, `show` with `-q` `-p`, `--quiet`, `--patch`, `--stat`, `--index` |
| `git fetch` | a remote and plain branch names; `-p` `-q` `-v` `-t`, `--depth <n>`, `--all`, `--prune`, `--[no-]tags`, `--quiet`, `--verbose`, `--dry-run` |
| `git pull` | a remote and a plain branch name; `-q` `-v`, `--ff-only`, `--no-rebase`, `--[no-]ff`, `--no-edit`, `--quiet`, `--verbose`, `--tags`, `--autostash` |
| `git push` | a remote and plain branch names (`a:b` too); `-u` `-n` `-q` `-v`, `--set-upstream`, `--dry-run`, `--quiet`, `--verbose`, `--tags`, `--follow-tags`, `--progress`, `--porcelain` |
| `git merge` | branches; `-m <msg>`, `-q` `-v`, `--message`, `--[no-]ff`, `--ff-only`, `--no-edit`, `--abort`, `--continue`, `--quit`, `--quiet`, `--verbose`, `--[no-]stat`, `--[no-]log` |
| `git rm` | files; `-r` `-n` `-q`, `--cached`, `--dry-run`, `--quiet`, `--ignore-unmatch` |
| `git mv` | files; `-n` `-v` `-k`, `--dry-run`, `--verbose` |
| `git clean` | `-n` or `--dry-run` (required: it only lists), `-d` `-x` `-X` `-q`, `--quiet` |
| `git rebase` | `--abort` or `--quit`, alone: steps out of a rebase already under way |
| `git remote` | nothing, `-v`, `--verbose`, `get-url <name>`, `show <name>` |
| `git tag` | listing, or `<name> [<commit>]`; `-m <msg>`, `-F <file>`, `-a` `-l` `-n`, `--message`, `--file`, `--annotate`, `--list` |
| `git reflog` | nothing, or `show`; the `git log` options above, and a branch or commit. Not `expire` or `delete`, and not `--output`, which overwrites a file |
| `git init` | `-b <branch>`, `-q`, `--initial-branch`, `--quiet`; a folder |
| `git clone` | `<url> [<folder>]`; `-b <branch>`, `-q`, `--branch`, `--depth <n>`, `--quiet`, `--[no-]single-branch` |
| `git config` | reading: a name, `--get`, `--get-all`, `--list`, `-l`, `--show-origin`, `--name-only`. Setting only `user.name`, `user.email`, `color.*`, `core.quotepath`, `core.autocrlf`, `core.safecrlf`, `init.defaultBranch`, `advice.*`, `push.default`, `push.autoSetupRemote`, `pull.ff` and `fetch.prune`, which can't start a program or make `pull` rebase. Scopes `--global`, `--local`, `--system` |

Commands that aren't git pass straight through to Claude Code's own permission prompts, except the
few that delete a whole project: `rm -rf .git` and `gh repo delete`.

## Refused on purpose

**The classic ways to lose work**, each with its own reason and a safer command:

| The agent wants to... | Why it's refused | What to do instead |
|---|---|---|
| `git push --force` (also `-f`, `--force-with-lease`, `+branch`) | Replaces the branch on GitHub; what it replaces is gone for everyone | `git pull`, fix conflicts, push normally |
| `git push --delete`, `git push origin :branch`, `--prune`, `--mirror` | Deletes branches on GitHub, unmerged commits included | Let GitHub delete the branch after the merge |
| `git reset --hard` (also `--merge`, `--keep`) | Throws away every uncommitted change | `git stash`, then `git stash pop` to bring it back |
| `git checkout -- <file>`, `git checkout .`, `git restore <file>` | Overwrites files with the last commit; uncommitted changes are gone | `git stash` |
| `git checkout --force`, `git switch --discard-changes` | Switches branches by throwing away uncommitted changes | Commit or stash first |
| `git clean -f` | Deletes untracked files, which git never saved | `git clean -n` to list them, then delete by hand |
| `git branch -d`, `-D`, `--force`, `checkout -B`, `switch -C` | Deletes or overwrites a branch, unmerged commits included | Leave it; GitHub offers to delete it after the merge |
| `git rebase` | Rewrites your branch's commits | `git merge main` |
| `git commit --amend` | Rewrites the last commit; if it's pushed, a force push has to follow | A new commit with the fix |
| `git stash drop`, `git stash clear` | Deletes stashed changes | Leave them; `git stash list` shows them |
| `git rm --force` | Deletes files that have uncommitted changes | Commit or stash first |
| `git filter-branch`, `git filter-repo` | Rewrite the whole history | Leave them to a maintainer |
| `rm -rf .git` | Deletes the project's entire history | Ask for help with whatever you were undoing |
| `gh repo delete` | Deletes the repository on GitHub | Archive it instead |

**Everything else in git**, such as `gc`, `prune`, `reflog expire`, `worktree remove`, `cherry-pick`,
`revert`, `submodule foreach`, `bisect run`, `difftool -x`, `archive --exec`, `commit --no-verify`,
`remote add`, git aliases and `git-*` helper programs: "not on the training-wheels list; ask a reviewer".

**Anything it can't read exactly**, refused rather than parsed. In a line that mentions git:

- a backslash or a line break;
- any redirection (`>`, `>>`, `<`, `&>` and the like), since `git show HEAD:notes.txt > notes.txt`
  writes over uncommitted work; only the plain `2>&1` is fine;
- a shell keyword as a command (`if`, `then`, `else`, `for`, `while`, `until`, `do`, `!` and the rest),
  which would put git behind a word the guard reads as a program; and `set -a`;
- an unquoted `*`, `?` or `[`, a shell variable, or setting a variable that names a program git runs
  (`PAGER`, `EDITOR`, `PATH` and the like);
- any character outside plain ASCII (PowerShell reads look-alikes such as `“ ” „ ‘ ’ ‚ ‛` as quotes,
  and en and em dashes as hyphens);
- in PowerShell, a backtick anywhere (its escape character), an unquoted `(`, `,` or `@`
  (subexpressions, arrays and splats build arguments the guard can't see), the call operator `&`,
  and dot-sourcing with `.`.

Anywhere: setting or exporting a `GIT_` variable, `$( ... )`, backticks, braces, process substitution, a
command named by an expression, variables set in front of git, git settings that name a program, and a
list of programs that carry another command (`xargs`, `env`, `eval`, `time`, `watch`, `su`, `cmd`,
`wsl`, `Invoke-Expression`, `Start-Process`, `Set-Variable`, `Set-Alias` and more, plus a shell or
PowerShell given a string or reading its input, and an interpreter running inline code). In front of a
command it reads past exactly `sudo`, `command`, `exec` and `nohup` with no options, `timeout N`, and
`nice` or `nice -n N`.

The refusal says to run the command itself, on one line, written out in full (for the ASCII rule: in
plain ASCII; for a redirection: without it). Two effects you'll notice: commit messages go in with `-m`
(one per paragraph), not a `$(cat <<EOF ...)` heredoc, and `2>/dev/null` can't follow a git command.
And the ASCII rule has one cost: a commit message (or a file name) with non-ASCII text, such as an
accented name or a curly apostrophe, is refused too, so commit messages stay in plain ASCII.

Every parser is one more place to be wrong, so the guard doesn't try to read these: a short list of
what's allowed, and refusing what it can't read, are the two rules that don't need another patch.

## What it isn't

**It's for catching a beginner's mistakes, not for stopping an adversary.** It catches the honest
mistakes an agent makes while trying to help, like "let me reset that for you", or "let me restore
that file". Anything that can run code can still get around a check like this, and some ways are
left open on purpose, because closing them would mean reading every program on the machine: a
wrapper that isn't on its list (`setsid`, `flock` or `winpty` in front of git), a PowerShell expression
that builds the word git out of other letters, deleting files inside `.git` with `rm` or `find` (only
`rm -rf .git` itself is refused, so a stale `.git/index.lock` can still be removed), a script that runs
git (the hook doesn't read scripts, `npm run` targets or Makefiles), or a program other than git that
changes files. The skill tells Claude not to look for a way around it. For real protection on a
shared branch, turn on branch protection on GitHub; for an agent you don't trust, run it in a sandbox.

If the hook itself ever fails (bad input, a Node error), it lets the command through and Claude Code
shows a one-line notice, rather than locking you out of git.

## Install

You need Claude Code, git, and Node.js 18 or later (the hook is one small Node script with no
dependencies).

**As a plugin**, for every project you work on:

```
/plugin marketplace add desertcache/training-wheels
/plugin install training-wheels@training-wheels
```

**In one repository**, for a class or a team, so everyone who opens the project gets it: copy
`scripts/training-wheels.mjs` to `.claude/hooks/` and `skills/first-pull-request/` to
`.claude/skills/` in that repository, then add this to its `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/training-wheels.mjs\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

**To try it once** without installing anything: `claude --plugin-dir path/to/training-wheels`.

Then say it's your first pull request, or start the walkthrough yourself:
`/training-wheels:first-pull-request` as a plugin, or `/first-pull-request` in the repository copy.

## A short demo

`node demo/run-demo.mjs` builds a throwaway repository with one committed file and an edit someone
regrets, then sends the hook exactly what Claude Code sends before a Bash command, for each command an
agent might reach for. Its output, with long lines wrapped and the `git restore` case left out:

```
$ git status --short
 M notes.txt

agent wants to run: git checkout -- notes.txt
  hook: deny. training-wheels stopped `git checkout -- <file>`: it replaces your files with the last
  committed version, and changes you haven't committed are gone for good. Instead: git stash sets
  your changes aside, and git stash pop brings them back.

agent wants to run: git reset --hard
  hook: deny. training-wheels stopped `git reset --hard`: it throws away every change you haven't
  committed, and git can't bring those changes back. Instead: git stash sets your changes aside,
  and git stash pop brings them back.

agent wants to run: git stash
  hook: no objection, so the command runs

$ git stash
Saved working directory and index state WIP on main: Add trail notes
$ cat notes.txt
# Trail notes
- Ridge trail: steep, bring water.
$ git stash pop    # and the edit is back, if it was wanted after all
# Trail notes
asdf asdf
```

In a session, Claude Code shows the person the "training-wheels stopped" line, gives Claude the
same sentence, and Claude takes the safer path.

## Tests

`npm test` runs the guard over every allowed command above, every classic way to lose work (with
abbreviations, quotes and the wrappers it strips), a sample of what's off the list, every form it
refuses because it can't read it, and commands that only mention danger (a commit message, an
`echo`). It also runs the hook the way Claude Code does: JSON in, a decision out.

## License

MIT

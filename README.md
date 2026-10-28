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

| Command | What's on the list |
|---|---|
| `git status`, `diff`, `log`, `show`, `blame`, `shortlog`, `ls-files`, `rev-parse`, `describe`, `grep`, `help`, `--version` | Read only, any options, except `--output` (it overwrites a file) and `grep -O` (it starts a program) |
| `git add` | Paths, `-A`, `-u`, `-n`, `-N`, `-v` (not `-f`, which adds ignored files such as secrets) |
| `git commit` | With a message: `-m` (one per paragraph), `-a`, `-F <file>` |
| `git switch` | `<branch>`, or `-c <new-branch>` |
| `git checkout` | `<branch>`, or `-b <new-branch>` |
| `git branch` | Listing, `<new-branch>`, `-u <upstream>` |
| `git restore --staged <file>` | Unstage a file; your changes stay |
| `git reset` | `--soft` or `--mixed`, a commit or files: takes a commit back and keeps every change |
| `git stash` | `push` (with `-m`, `-u`), `pop`, `apply`, `list`, `show` |
| `git fetch`, `git pull` | A remote and branch; `--prune`, `--tags`, `--ff-only` |
| `git push` | A remote and branch; `-u`, `--dry-run`, `--tags`, `--follow-tags` |
| `git merge` | A branch; `--no-ff`, `--ff-only`, `-m`, `--abort`, `--continue` |
| `git rm`, `git mv` | Files, without `--force` |
| `git clean -n` | Lists what `clean -f` would delete |
| `git rebase --abort` | Steps out of a rebase someone else started |
| `git remote -v`, `git tag`, `git reflog`, `git init`, `git clone <url>` | As written; `tag` may create, not delete |
| `git config` | Reading any setting; setting only names, email, colors and similar ones that can't start a program |

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

**Anything it can't read exactly**, refused rather than parsed. In a line that mentions git: a
backslash, a line break, a redirection that can carry a word (`>&`, `<&`, `&>`, `|&`; the plain `2>&1`
is fine), an unquoted `*`, `?` or `[`, a shell variable, and a PowerShell `@splat`. Anywhere: `$( ... )`,
backticks, braces, process substitution, a command named by an expression, variables set in front of
git, git settings that name a program, and the programs that carry another command (`xargs`, `env`,
`eval`, `Invoke-Expression`, `Start-Process`, `Set-Variable`, `Set-Alias`, a shell or PowerShell given a
string or reading its input, an interpreter running inline code, and any wrapper other than `sudo`,
`command`, `exec`, `timeout N`, `nice` and `nohup`). The refusal says to run the command itself, on one
line, written out in full. One effect you'll notice: commit messages go in with `-m` (one per
paragraph), not a `$(cat <<EOF ...)` heredoc.

Every parser is one more place to be wrong, so the guard doesn't try to read these: a short list of
what's allowed, and refusing what it can't read, are the two rules that don't need another patch.

## What it isn't

**It's for catching a beginner's mistakes, not for stopping an adversary.** It catches the honest
mistakes an agent makes while trying to help, like "let me reset that for you", and refusing the
wrappers is part of that design, not a gap. Anything that can run code can still get around a check
like this: an agent determined to could write a script that runs git (the hook doesn't read scripts,
`npm run` targets or Makefiles), or use a program other than git to change files. The skill tells
Claude not to look for a way around it. For real protection on a shared branch, turn on branch
protection on GitHub; for an agent you don't trust, run it in a sandbox.

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

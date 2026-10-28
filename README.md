# Training wheels for a first pull request

A Claude Code plugin for someone making their first pull request. A skill walks them through
branch, commit, pull request and merge in plain words, and a hook stops the few git commands that
can't be taken back.

## The rule

**Everything you do here can be undone.**

People who are new to git are mostly afraid of one thing: breaking something they can't fix. The
fear is reasonable, because a handful of git commands really do throw work away for good. Take that
handful off the table and the promise becomes true: any step can be reversed, so it's safe to try
things.

When an AI agent is the one typing the commands, the promise has to be enforced, not just said. So
the hook runs before every shell command the agent wants to run, and when a command would lose work
or rewrite history other people may already have, it refuses, says why in one sentence, and names
a safer command.

## What it costs

It refuses commands experienced people use every day: force pushes, hard resets, rebases, amended
commits, forced branch deletes. If you know what you're doing, you'll run into it. That's the trade:
a beginner can't lose work by accident, and an expert has to step around the guard on purpose. Two
ways to do that:

- **Run the command yourself in a terminal.** The hook only stops the agent, never you.
- **Turn it off for a session.** Start Claude Code with `TRAINING_WHEELS=off` in its environment:
  `TRAINING_WHEELS=off claude` in bash, or `$env:TRAINING_WHEELS = 'off'; claude` in PowerShell.

## What it stops

| The agent wants to... | Why it's stopped | What to do instead |
|---|---|---|
| `git push --force` (also `-f`, `--force-with-lease`, `+branch`) | Replaces the branch on GitHub; what it replaces is gone for everyone | `git pull`, fix conflicts, push normally |
| `git push --delete`, `git push origin :branch`, `--prune`, `--mirror` | Deletes branches on GitHub, unmerged commits included | Let GitHub delete the branch after the merge |
| `git reset --hard` | Throws away every uncommitted change | `git stash`, then `git stash pop` to bring it back |
| `git checkout -- <file>`, `git checkout .`, `git restore <file>` | Overwrites files with the last commit; uncommitted changes are gone | `git stash` |
| `git checkout --force`, `git switch --discard-changes` | Switches branches by throwing away uncommitted changes | Commit or stash first |
| `git clean -f` | Deletes untracked files, which git never saved | `git clean -n` to list them, then delete by hand |
| `git branch -D`, `git branch --force`, `checkout -B`, `switch -C` | Deletes or overwrites a branch, unmerged commits included | `git branch -d`, which only deletes merged work |
| `git rebase` (except `--abort`) | Rewrites your branch's commits | `git merge main` |
| `git commit --amend` | Rewrites the last commit; if it's pushed, a force push has to follow | A new commit with the fix |
| `git stash drop`, `git stash clear` | Deletes stashed changes | Leave them; `git stash list` shows them |
| `git rm --force`, `git worktree remove --force` | Deletes files that have uncommitted changes | Commit or stash first |
| `git filter-branch`, `git filter-repo`, `git reflog expire`, `git gc --prune=now`, `git prune`, `git update-ref -d` | Rewrite history, or erase the records lost work is recovered from | Leave them to a maintainer |
| `rm -rf .git` | Deletes the project's entire history | Ask for help with whatever you were undoing |
| `gh repo delete` | Deletes the repository on GitHub | Archive it instead |

It reads each command the way a shell would. It checks every part of `a && b; c | d` and what runs
inside `$( ... )`; looks inside `bash -c "..."`, `powershell -Command "..."` (and its abbreviations),
`cmd /c`, `eval` and `Invoke-Expression`; sees past `sudo`, `env`, `timeout`, `xargs` and a full path
to git; matches git's abbreviated options (`--forc` is `--force` to git, so it is here too); looks up
your git aliases; and ignores text that only mentions a command, like a commit message or a file
written from a heredoc. It checks the Bash tool and the PowerShell tool.

Where it can't see what a command will run, it refuses instead of guessing: a shell variable or
`$( ... )` in a git command (except in a commit message or a `-C` path), an encoded PowerShell
command, commands piped into a shell, and git config passed in through the environment.

## What it isn't

**It's for catching a beginner's mistakes, not for stopping an adversary.** It catches the honest
mistakes an agent makes while trying to help, like "let me reset that for you". Anything that can run
code can get around a check like this: an agent determined to could write a script that runs git
(the hook doesn't read scripts, `npm run` targets or Makefiles), or use a program other than git to
change files. The skill tells Claude not to look for a way around it. For real protection on a
shared branch, turn on branch protection on GitHub; for an agent you don't trust, run it in a
sandbox.

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

`npm test` runs every command in the table above through the guard (with their abbreviations, quoting
tricks, wrappers, aliases and nested shells), plus everyday commands that must
pass (`git status`, `git push -u origin`, `git branch -d`, `git restore --staged`, `git reset --soft`,
`git clean -n`, commit messages that mention dangerous commands, and heredocs), and runs the hook the
way Claude Code does: JSON in, a decision out.

## License

MIT

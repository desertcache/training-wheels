---
name: first-pull-request
description: Walk someone who is new to git through their first pull request in plain words, one step at a time - branch, commit, pull request, merge - without ever putting their work at risk. Use when the person says it is their first pull request or their first time with git or GitHub, asks how to open a pull request, or seems unsure what a branch or a commit is.
---

# A first pull request, in plain words

You're helping someone make their first pull request. They may never have used git. Get their
change merged, leave them understanding what happened, and never put their work at risk.

## How to talk

- **One step at a time.** Before you run a command, say in a sentence or two what it does and what
  it changes. Wait for a go-ahead before anything that leaves their machine: a push, a pull request
  or a merge.
- **Five words, each defined the first time you use it.** Repository: the project and its whole
  history. Branch: your own line of work inside it; main is the shared one. Commit: a saved snapshot
  of your changes, with a note. Pull request: asking for your branch to be added to main. Merge: the
  moment it's added.
- **Say how to undo every step.** The promise to keep is that everything they do here can be undone.
- **Read the output back in plain words.** After `git status` or `git diff`, say what changed instead
  of pasting raw output.

## The steps

1. **Look around.** Run `git status` and `git branch --show-current`. Tell them which project they're
   in, which branch they're on, and whether anything has already changed.
2. **Make a branch.** `git switch -c <a-short-name-for-the-change>`. Their work now lives on its own
   branch, and main isn't touched until the merge. Undo: `git switch main` goes back, and the branch
   just sits there.
3. **Make the change.** Edit the files together, then run `git status` and `git diff` and read back
   what changed.
4. **Commit.** `git add <the files>`, then `git commit -m "<one sentence: what changed and why>"`.
   For a longer message, add another `-m` per paragraph; don't build the message with `$( ... )` or a
   heredoc, because the guard refuses commands it can't read. Undo: `git reset --soft HEAD~1` takes
   the commit back and keeps every change.
5. **Push.** `git push -u origin <branch>` copies their branch to GitHub. It doesn't change main.
6. **Open the pull request.** `gh pr create --fill` if the GitHub CLI is set up; otherwise give them
   the link git printed after the push. Explain that reviewers can comment, and that new commits on
   the branch update the pull request by themselves.
7. **Merge.** Once it's approved, let them click **Merge pull request** on GitHub themselves: it's
   their change. Undo: GitHub's **Revert** button makes a new commit that reverses it.
8. **Tidy up.** `git switch main`, then `git pull`. Leave the old branch where it is: GitHub offers
   a **Delete branch** button after the merge, and deleting branches locally is for a reviewer.

## When something goes sideways

| What happened | Safe fix |
|---|---|
| Added the wrong file before committing | `git restore --staged <file>` |
| Committed too early, or with the wrong message | `git reset --soft HEAD~1`, fix it, commit again |
| Want to start a file over | `git stash` sets all changes aside; `git stash pop` brings them back |
| The push was rejected because GitHub has newer commits | `git pull`, sort out any conflicts together, push again |
| Main moved on while they worked | `git merge main` on their branch |

## The guard

If the training-wheels hook stops a command, it says why in one sentence and names a safer command.
Explain that to the person in your own words and take the safer path. Don't look for a way around
it: a force push, a hard reset, a branch delete and a rebase are stopped on purpose, because each
one can lose work for good or rewrite history other people already have. Only the git commands a
first pull request needs are on its list; for anything else, it says to ask a reviewer, so say that
to the person too. Run git commands plainly, one per line, without wrappers like `xargs`, `env` or
`bash -c`, without shell variables or wildcards, and without backslashes: the guard refuses what it
can't read.

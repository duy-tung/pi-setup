#!/usr/bin/env bash
# Decide the three open v0.3 issues empirically: case collisions, nested repos,
# symlinks/hardlinks. Every fixture is built from scratch under /tmp.
set -u

B=/tmp/pi-hazards; rm -rf $B; mkdir -p $B
pass() { echo "    ✓ $*"; }
fail() { echo "    ✗ $*"; }
shadow() { # $1 = worktree ; sets G/I for subsequent sgit calls
  G=$B/$(basename "$1").git; I=$B/$(basename "$1").idx
  rm -rf "$G" "$I"; git init -q --bare "$G"; git --git-dir="$G" config core.bare false
  mkdir -p "$G/info"; printf '* -text -diff -filter -crlf -working-tree-encoding\n' > "$G/info/attributes"
  WT="$1"
}
sgit() { env GIT_DIR="$G" GIT_WORK_TREE="$WT" GIT_INDEX_FILE="$I" \
             GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git "$@"; }

echo "═══ A. case-only collisions ═══════════════════════════════════════════"
A=$B/case; mkdir -p $A/inc
echo 'LOWER content' > $A/inc/xt_connmark.h     # on APFS this is the only file
shadow $A
sgit add -A 2>/dev/null
echo "  A1 what does 'add -f <UPPERCASE variant>' do when only lowercase exists?"
sgit add -f -- inc/xt_CONNMARK.h 2>&1 | sed 's/^/       /'
n=$(sgit ls-files | wc -l | tr -d ' ')
sgit ls-files | sed 's/^/       index: /'
[ "$n" = "1" ] && pass "seed did not inject a phantom path (index still $n entry)" \
                || fail "seed injected a second path -> restore would write wrong content"

echo "  A2 can a tree holding BOTH cases even be checked out here?"
blob_l=$(printf 'LOWER\n' | git --git-dir=$G hash-object -w --stdin)
blob_u=$(printf 'UPPER\n' | git --git-dir=$G hash-object -w --stdin)
env GIT_DIR=$G GIT_INDEX_FILE=$B/both.idx git update-index --add --cacheinfo 100644,$blob_l,inc/xt_connmark.h
env GIT_DIR=$G GIT_INDEX_FILE=$B/both.idx git update-index --add --cacheinfo 100644,$blob_u,inc/xt_CONNMARK.h
mkdir -p $B/case-out
env GIT_DIR=$G GIT_INDEX_FILE=$B/both.idx git --work-tree=$B/case-out checkout-index -a -f 2>&1 | sed 's/^/       /'
echo "       files on disk: $(ls $B/case-out/inc | tr '\n' ' ')"
echo "       content:       $(cat $B/case-out/inc/xt_connmark.h 2>/dev/null | tr -d '\n')  <- one silently won"

echo
echo "═══ B. nested repo / submodule ════════════════════════════════════════"
N=$B/nested; mkdir -p $N/src $N/vendor
echo 'main' > $N/src/main.go
( cd $N/vendor && git init -q dep && echo 'v1' > dep/lib.go && cd dep && git add -A && \
  git -c user.email=a@b -c user.name=a commit -qm i ) >/dev/null 2>&1
shadow $N
sgit add -A 2>/dev/null
echo "  B1 plain add -A:"; sgit ls-files -s | sed 's/^/       /'
echo "  B2 force-add a file INSIDE the nested repo:"
sgit add -f -- vendor/dep/lib.go 2>&1 | sed 's/^/       /'
sgit ls-files -s -- vendor | sed 's/^/       /'
echo "  B3 same, with submodule.recurse / core.protectNTFS off and --no-warn:"
sgit -c submodule.active=false add -f -- vendor/dep/lib.go 2>&1 | sed 's/^/       /'
echo "  B4 dedicated shadow repo for the nested worktree:"
shadow $N/vendor/dep 2>/dev/null; WT=$N/vendor/dep
sgit add -A 2>/dev/null; sgit ls-files -s | sed 's/^/       /'
[ -n "$(sgit ls-files)" ] && pass "a per-nested-repo shadow captures its contents fine" \
                          || fail "even a dedicated shadow cannot see it"

echo
echo "═══ C. symlinks ═══════════════════════════════════════════════════════"
S=$B/sym; mkdir -p $S/d
echo 'target content' > $S/d/real.txt
ln -s d/real.txt   $S/link-file
ln -s d            $S/link-dir
ln -s nowhere.txt  $S/link-dangling
shadow $S; sgit add -A 2>/dev/null
sgit ls-files -s | sed 's/^/       /'
mkdir -p $B/sym-out
sgit --work-tree=$B/sym-out checkout-index -a -f 2>&1 | sed 's/^/       /'
for l in link-file link-dir link-dangling; do
  if [ -L "$B/sym-out/$l" ]; then pass "$l restored as symlink -> $(readlink $B/sym-out/$l)"
  else fail "$l restored as a REGULAR FILE (link materialised)"; fi
done

echo
echo "═══ D. hardlinks ══════════════════════════════════════════════════════"
H=$B/hard; mkdir -p $H
echo 'v1' > $H/a.txt; ln $H/a.txt $H/b.txt
echo "  nlink before: a=$(stat -f %l $H/a.txt) b=$(stat -f %l $H/b.txt)  inode=$(stat -f %i $H/a.txt)"
shadow $H; sgit add -A 2>/dev/null
echo 'v2 modified' > $H/a.txt   # note: '>' truncates in place, keeps the link
ino_before=$(stat -f %i $H/a.txt)

echo "  D1 restore via checkout-index (what git does):"
sgit checkout-index -f -- a.txt
echo "       nlink a=$(stat -f %l $H/a.txt) b=$(stat -f %l $H/b.txt)  inode $ino_before -> $(stat -f %i $H/a.txt)"
echo "       b.txt content: $(cat $H/b.txt | tr -d '\n')"
[ "$(stat -f %l $H/a.txt)" = "2" ] && pass "hardlink survived checkout-index" \
                                   || fail "checkout-index BROKE the hardlink (b.txt orphaned)"

echo "  D2 restore by writing in place (open+truncate, keep inode):"
rm -f $H/a.txt $H/b.txt; echo 'v1' > $H/a.txt; ln $H/a.txt $H/b.txt
sgit add -A 2>/dev/null; echo 'v2 modified' > $H/a.txt
ino_before=$(stat -f %i $H/a.txt)
sgit cat-file blob "$(sgit ls-files -s -- a.txt | awk '{print $2}')" > $H/a.txt   # in-place truncate+write
echo "       nlink a=$(stat -f %l $H/a.txt) b=$(stat -f %l $H/b.txt)  inode $ino_before -> $(stat -f %i $H/a.txt)"
echo "       b.txt content: $(cat $H/b.txt | tr -d '\n')"
[ "$(stat -f %l $H/a.txt)" = "2" ] && pass "hardlink survived in-place write, b.txt tracked the change" \
                                   || fail "in-place write broke the hardlink too"

echo
echo "═══ E. does in-place write also keep symlinks and perms sane? ═════════"
P=$B/perm; mkdir -p $P; printf '#!/bin/sh\necho v1\n' > $P/run.sh; chmod 755 $P/run.sh
shadow $P; sgit add -A 2>/dev/null
printf '#!/bin/sh\necho v2\n' > $P/run.sh; chmod 644 $P/run.sh
sgit checkout-index -f -- run.sh
echo "       mode after checkout-index: $(stat -f %Lp $P/run.sh) (index says $(sgit ls-files -s -- run.sh | awk '{print $1}'))"
[ "$(stat -f %Lp $P/run.sh)" = "755" ] && pass "exec bit restored" || fail "exec bit NOT restored — must chmod explicitly"

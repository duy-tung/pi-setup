#!/usr/bin/env bash
# Round 2: the restore-side edge cases — symlink write-through, file<->dir
# swaps, and what a restore does to a nested repo.
set -u
B=/tmp/pi-hazards2; rm -rf $B; mkdir -p $B
pass() { echo "    ✓ $*"; }
fail() { echo "    ✗ $*"; }
shadow() { G=$B/$(basename "$1").git; I=$B/$(basename "$1").idx
  rm -rf "$G" "$I"; git init -q --bare "$G"; git --git-dir="$G" config core.bare false
  mkdir -p "$G/info"; printf '* -text -diff -filter -crlf\n' > "$G/info/attributes"; WT="$1"; }
sgit() { env GIT_DIR="$G" GIT_WORK_TREE="$WT" GIT_INDEX_FILE="$I" \
             GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git "$@"; }

echo "═══ F. symlink write-through (security boundary) ══════════════════════"
F=$B/sym2; mkdir -p $F
echo 'SECRET - must not be touched' > $B/outside.txt
echo 'original config' > $F/conf.txt
shadow $F; sgit add -A 2>/dev/null
rm $F/conf.txt; ln -s $B/outside.txt $F/conf.txt     # agent/attacker swaps in a link
sgit checkout-index -f -- conf.txt 2>&1 | sed 's/^/       /'
echo "       outside.txt now: $(cat $B/outside.txt)"
echo "       conf.txt is a $([ -L $F/conf.txt ] && echo symlink || echo 'regular file')"
grep -q SECRET $B/outside.txt && pass "checkout-index replaced the link, did NOT write through" \
                              || fail "WROTE THROUGH the symlink — restore can clobber files outside the repo"

echo
echo "═══ G. file <-> directory swaps ═══════════════════════════════════════"
G1=$B/swap; mkdir -p $G1
echo 'i am a file' > $G1/thing
shadow $G1; sgit add -A 2>/dev/null
rm $G1/thing; mkdir $G1/thing; echo 'inner' > $G1/thing/inner.txt   # file -> dir
echo "  G1 snapshot says file, disk now has a directory:"
sgit checkout-index -f -- thing 2>&1 | sed 's/^/       /'
if [ -f $G1/thing ]; then pass "restored as a file (directory was replaced)"
elif [ -d $G1/thing ]; then fail "refused — directory left in place, restore incomplete"; fi

G2=$B/swap2; mkdir -p $G2/thing; echo 'inner' > $G2/thing/inner.txt
shadow $G2; sgit add -A 2>/dev/null
rm -rf $G2/thing; echo 'now a file' > $G2/thing                      # dir -> file
echo "  G2 snapshot says directory, disk now has a file:"
sgit checkout-index -f -- thing/inner.txt 2>&1 | sed 's/^/       /'
if [ -f $G2/thing/inner.txt ]; then pass "restored (file was replaced by the directory)"
else fail "refused — must be handled explicitly"; fi

echo
echo "═══ H. what does restore do to a nested repo? ═════════════════════════"
H=$B/nest2; mkdir -p $H/src $H/vendor
echo 'main' > $H/src/main.go
( cd $H/vendor && git init -q dep && echo 'v1' > dep/lib.go && cd dep && git add -A && \
  git -c user.email=a@b -c user.name=a commit -qm i ) >/dev/null 2>&1
shadow $H; sgit add -A 2>/dev/null
echo 'v2 EDITED BY AGENT' > $H/vendor/dep/lib.go
echo "  H1 full restore over a modified nested repo:"
sgit checkout-index -a -f 2>&1 | sed 's/^/       /'
echo "       vendor/dep/lib.go = $(cat $H/vendor/dep/lib.go)"
grep -q v2 $H/vendor/dep/lib.go && fail "nested edit NOT reverted (expected: gitlink is opaque)" \
                                || pass "nested edit reverted"
echo "  H2 does the gitlink entry make checkout-index create anything?"
rm -rf $B/nest-out; mkdir -p $B/nest-out
sgit --work-tree=$B/nest-out checkout-index -a -f 2>&1 | sed 's/^/       /'
echo "       created: $(cd $B/nest-out && find . -mindepth 1 | sed 's|^\./||' | tr '\n' ' ')"

echo
echo "═══ I. cost of detecting case collisions on a 95k-file index ══════════"
L="${PI_REWIND_CORPUS:-}"
if [ -n "$L" ] && [ -d "$L" ]; then
  /usr/bin/time -p bash -c "cd $L && git ls-files -z | tr '\0' '\n' | tr 'A-Z' 'a-z' | sort | uniq -d | wc -l" 2>&1 | sed 's/^/       /'
fi

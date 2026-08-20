#!/bin/bash
# STA-2408 rev-3 §4 fresh pre-state sweep (read-only)
REPO=stayinsured/web-platform
WF=272513204
OUT=artifacts/STA-2408
FROZEN=8582652e6f4f73191389360e2a77529d46a73bc9
VGBRANCH=visual-gate/sta-2282-8582652e
LOG=$OUT/prestate-summary.txt
: > $LOG
say(){ echo "$*" | tee -a $LOG; }
say "STA-2408 rev-3 §4 pre-state sweep $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 1. workflow identity
gh api repos/$REPO/actions/workflows/$WF > $OUT/wf-identity.json 2>$OUT/wf-identity.err && \
  say "PASS | §4 workflow identity | id=$(python3 -c "import json;d=json.load(open('$OUT/wf-identity.json'));print(d['id'],d['path'],d['state'],d['name'])")" || \
  say "FAIL | §4 workflow identity fetch"

# 2. dispatch-event run baseline
gh api "repos/$REPO/actions/workflows/$WF/runs?event=workflow_dispatch&per_page=100" > $OUT/dispatch-runs-pre.json
python3 - >> $LOG <<'PY'
import json
d=json.load(open('artifacts/STA-2408/dispatch-runs-pre.json'))
runs=d.get('workflow_runs',[])
print(f"dispatch-event total_count={d.get('total_count')}")
for r in runs:
    print(f"  run {r['id']} #{r['run_number']} attempt={r['run_attempt']} {r['status']}/{r['conclusion']} head={r['head_sha'][:10]} branch={r['head_branch']} created={r['created_at']}")
ok = d.get('total_count')==1 and len(runs)==1 and runs[0]['id']==32257803101 and runs[0]['status']=='completed' and runs[0]['run_attempt']==1
print("PASS | §4.2 dispatch baseline ==1 (spent rev-2 trial 32257803101)" if ok else "FAIL | §4.2 dispatch baseline")
PY

# 3. five frozen blobs at stated commits
check_blob(){ # path ref expected
  local got
  got=$(gh api "repos/$REPO/contents/$1?ref=$2" --jq '.sha' 2>/dev/null)
  if [ "$got" = "$3" ]; then say "PASS | §4.5 blob $1 @ ${2:0:10} == ${3:0:8}"; else say "FAIL | §4.5 blob $1 @ ${2:0:10} got=${got:-MISSING} want=$3"; fi
}
check_blob ".github/workflows/hs-visual-regression.yml" $FROZEN 6e19bab7b2e030560ad9490335a6ef0883a1af53
check_blob ".github/config/hs-visual-regression-contract.v2.json" ff593d26ec41565e1414175f012f79803438642b c7e6a8e8e5b554d530e52152311e4692767302fe
check_blob ".github/config/hs-visual-regression-contract.v2.json" $FROZEN f76cddcab55b553e3dfe6b920d2c271721cc5788
check_blob "scripts/hs-visual-regression-evidence.mjs" $FROZEN 244a3cf31df940b0e6269acb6262a37735ecd325
check_blob ".github/workflows/hs-visual-regression.test.mjs" $FROZEN 6957b075155bd2b423d46dbfe46267245c0ca30c
# frozen commit shape
gh api repos/$REPO/git/commits/$FROZEN > $OUT/frozen-commit.json
python3 - >> $LOG <<'PY'
import json
c=json.load(open('artifacts/STA-2408/frozen-commit.json'))
ok = [p['sha'] for p in c['parents']]==['ff593d26ec41565e1414175f012f79803438642b'] and c['tree']['sha']=='4803b656275362c7b56a9682655a089230f5882c'
print(("PASS" if ok else "FAIL")+f" | §4.5 frozen commit shape | parents={[p['sha'][:8] for p in c['parents']]} tree={c['tree']['sha'][:12]}")
PY

# 4. no persistent gate: yml input default at frozen + dev tip; repo variables
for REF in $FROZEN dev; do
  gh api "repos/$REPO/contents/.github/workflows/hs-visual-regression.yml?ref=$REF" --jq '.content' 2>/dev/null | base64 -d > $OUT/yml-$REF.yml
  python3 - "$REF" >> $LOG <<'PY'
import sys,re
ref=sys.argv[1][:10]
t=open(f'artifacts/STA-2408/yml-{sys.argv[1]}.yml').read()
m=re.search(r'visual_gate_required:\s*\n(.*?)(^\s*\w[\w-]*:|$)', t, re.M|re.S)
blk=m.group(1) if m else ''
has_true_default = 'default: true' in blk or 'default:true' in blk
print(("PASS" if not has_true_default else "FAIL")+f" | §4.3 yml@{ref} visual_gate_required default_true={has_true_default} (input-only gate)")
PY
done
gh api repos/$REPO/actions/variables --jq '.variables[].name' > $OUT/repo-variables.txt 2>/dev/null
python3 - >> $LOG <<'PY'
names=[l.strip() for l in open('artifacts/STA-2408/repo-variables.txt') if l.strip()]
hits=[n for n in names if 'gate' in n.lower() or 'visual' in n.lower()]
print(("PASS" if not hits else "FAIL")+f" | §4.3 no persistent gate variable | matches={hits} (of {len(names)} vars)")
PY

# 5. refs: vg branch resolution + full heads sweep vs rev-2 post-dispatch baseline
gh api repos/$REPO/git/ref/heads/$VGBRANCH > $OUT/branch-ref.json 2>/dev/null
python3 - >> $LOG <<'PY'
import json
r=json.load(open('artifacts/STA-2408/branch-ref.json'))
ok=r['object']['sha']=='8582652e6f4f73191389360e2a77529d46a73bc9' and r['object']['type']=='commit'
print(("PASS" if ok else "FAIL")+f" | §4.6 authorized ref -> {r['object']['sha']} ({r['object']['type']})")
PY
gh api "repos/$REPO/git/matching-refs/heads?per_page=100" --paginate > $OUT/heads-sweep.json 2>/dev/null || gh api "repos/$REPO/git/matching-refs/heads" > $OUT/heads-sweep.json
python3 - >> $LOG <<'PY'
import json
cur={}
for line in open('artifacts/STA-2408/heads-sweep.json'):
    line=line.strip()
    if not line: continue
    try: r=json.loads(line)
    except json.JSONDecodeError: continue
    if isinstance(r,dict) and 'ref' in r: cur[r['ref']]=r['object']['sha']
if not cur:  # non-paginated single doc
    try:
        d=json.load(open('artifacts/STA-2408/heads-sweep.json'))
        for r in (d if isinstance(d,list) else []): cur[r['ref']]=r['object']['sha']
    except Exception: pass
frozen='8582652e6f4f73191389360e2a77529d46a73bc9'
at=[k for k,v in cur.items() if v==frozen]
print(f"heads total={len(cur)}; refs at frozen SHA: {at}")
print(("PASS" if at==['refs/heads/visual-gate/sta-2282-8582652e'] else "FAIL")+f" | §4.6 exactly one ref at frozen SHA")
json.dump(cur,open('artifacts/STA-2408/heads-current.json','w'),indent=1,sort_keys=True)
PY

say "--- refs-vs-baseline + health probe + deployments recorded separately ---"

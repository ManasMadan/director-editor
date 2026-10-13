# The backup drill (templates/restore-drill.yaml): restores the latest backup into a
# scratch cluster, the way a real restore would (a base backup, then the archived WAL),
# and checks it against the live database: the same tables, row-level security,
# policies, grants, functions and extensions, and a last transaction recent enough. The
# scratch cluster is deleted afterwards, whatever the outcome.
#
# CLUSTER: the live cluster. DRILL: the scratch one, defined in $SPEC. DATABASE: the
# database to compare. MAX_AGE_HOURS: how old the restored data may be. TIMEOUT: how long
# the restore may take. FINGERPRINT: the query listing the facts (files/fingerprint.sql).
set -eu
work=${TMPDIR:-/tmp}

remove() { kubectl delete cluster "$DRILL" --ignore-not-found --wait=false >/dev/null; }
trap remove EXIT

# A scratch cluster a failed run left behind would hide this run's restore.
kubectl delete cluster "$DRILL" --ignore-not-found --wait=true
kubectl apply -f "$SPEC"
echo "Restoring the latest backup into $DRILL (up to $TIMEOUT)"
kubectl wait "cluster/$DRILL" --for=condition=Ready --timeout="$TIMEOUT"

sql() {
  pod=$(kubectl get pod -l "cnpg.io/cluster=$1,cnpg.io/instanceRole=primary" \
    -o jsonpath='{.items[0].metadata.name}')
  kubectl exec "$pod" -c postgres -- psql -X -A -t -q -v ON_ERROR_STOP=1 -d "$DATABASE" -c "$2"
}
# What a later write changes (rows and sequences) is left out: the live database has
# moved on since the backup.
facts() {
  sql "$1" "$(cat "$FINGERPRINT")" |
    sed -E -e 's/ rows=[0-9]+ hash=[-0-9.]+//' -e '/^sequence /d' | sort
}

facts "$CLUSTER" > "$work/live"
facts "$DRILL" > "$work/restored"
if ! diff -u "$work/live" "$work/restored"; then
  echo "The restored database differs from the live one (above: - live, + restored)." >&2
  exit 1
fi

age=$(sql "$DRILL" "select coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp())::int, -1)")
if [ "$age" -lt 0 ]; then
  echo "The restore replayed no transactions: the WAL archive is empty or unreadable." >&2
  exit 1
fi
if [ "$age" -gt $((MAX_AGE_HOURS * 3600)) ]; then
  echo "The restored data is $((age / 3600)) hours old, more than $MAX_AGE_HOURS: WAL isn't being archived." >&2
  exit 1
fi
echo "Restored $(grep -c '^table ' "$work/live") tables, identical in structure; the last transaction is $((age / 60)) minutes old."

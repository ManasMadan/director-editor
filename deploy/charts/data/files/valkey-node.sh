# Starts one Valkey node of a replicated set (templates/valkey.yaml). It replicates from
# the primary the Sentinels name: any Sentinel that answers, else the one this node's own
# Sentinel last knew of (every pod restarting at once), else the first node (the very
# first start, or turning replication on for a single node's data).
#
# NODES: every node's host name, first to last. SELF: this node's. DATA: its disk.
set -eu
DATA=${DATA:-/data}
primary=""
for node in $NODES; do
  primary=$(valkey-cli -t 2 -h "$node" -p 26379 --raw \
    sentinel get-master-addr-by-name primary 2>/dev/null | head -n 1) || true
  [ -n "$primary" ] && break
done
if [ -z "$primary" ] && [ -f "$DATA/sentinel.conf" ]; then
  primary=$(awk '$1 == "sentinel" && $2 == "monitor" { print $4 }' "$DATA/sentinel.conf")
fi
[ -n "$primary" ] || primary=${NODES%% *}
set -- --replica-announce-ip "$SELF"
if [ "$primary" != "$SELF" ]; then set -- "$@" --replicaof "$primary" 6379; fi
exec valkey-server --requirepass "$VALKEY_PASSWORD" --masterauth "$VALKEY_PASSWORD" \
  --appendonly yes --maxmemory "$MAXMEMORY" --maxmemory-policy noeviction --dir "$DATA" "$@"

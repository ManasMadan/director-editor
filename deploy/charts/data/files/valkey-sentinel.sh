# Starts the Sentinel beside a Valkey node (templates/valkey.yaml). Its configuration,
# which it rewrites with what it learns (the current primary above all), stays on the
# node's disk across restarts; only the name it announces and the password are set anew
# each time.
#
# NODES: every node's host name, first to last. SELF: this node's. QUORUM: how many
# Sentinels must agree the primary is gone. DATA: the node's disk.
set -eu
DATA=${DATA:-/data}
conf="$DATA/sentinel.conf"
if [ ! -f "$conf" ]; then
  cat > "$conf" <<CONF
port 26379
sentinel resolve-hostnames yes
sentinel announce-hostnames yes
sentinel monitor primary ${NODES%% *} 6379 $QUORUM
sentinel down-after-milliseconds primary 5000
sentinel failover-timeout primary 60000
sentinel parallel-syncs primary 1
CONF
fi
grep -v -e '^sentinel announce-ip ' -e '^sentinel auth-pass ' "$conf" > "$conf.new" || true
echo "sentinel announce-ip $SELF" >> "$conf.new"
echo "sentinel auth-pass primary $VALKEY_PASSWORD" >> "$conf.new"
mv "$conf.new" "$conf"
exec valkey-sentinel "$conf"

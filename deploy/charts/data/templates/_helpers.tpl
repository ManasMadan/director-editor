{{- define "data.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "data.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ include "data.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* The CloudNativePG cluster's name. */}}
{{- define "data.postgres" -}}
{{- printf "%s-postgres" (include "data.name" .) -}}
{{- end -}}

{{/* The primary's read-write service (CloudNativePG creates <cluster>-rw). */}}
{{- define "data.postgresHost" -}}
{{- printf "%s-rw.%s.svc.cluster.local" (include "data.postgres" .) .Release.Namespace -}}
{{- end -}}

{{- define "data.valkey" -}}
{{- printf "%s-valkey" (include "data.name" .) -}}
{{- end -}}

{{/*
What a replicated Valkey node's scripts read (files/valkey-*.sh): every node's host name
and this pod's, the Service in front of it. (list $ nodes)
*/}}
{{- define "data.valkeyNodeEnv" -}}
{{- $root := index . 0 -}}
- { name: NODES, value: {{ join " " (index . 1) | quote }} }
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- { name: SELF, value: "$(POD_NAME).{{ $root.Release.Namespace }}.svc.cluster.local" }
{{- end -}}

{{- define "data.valkeyHost" -}}
{{- printf "%s.%s.svc.cluster.local" (include "data.valkey" .) .Release.Namespace -}}
{{- end -}}

{{/* A RustFS server: (list $ "uploads") → <release>-uploads. */}}
{{- define "data.rustfs" -}}
{{- printf "%s-%s" (include "data.name" (index . 0)) (index . 1) -}}
{{- end -}}

{{- define "data.rustfsEndpoint" -}}
{{- $root := index . 0 -}}
{{- printf "http://%s.%s.svc.cluster.local:9000" (include "data.rustfs" .) $root.Release.Namespace -}}
{{- end -}}

{{/* The backups server's root keys (the ObjectStore and the bucket Job read them). */}}
{{- define "data.backupsSecret" -}}
{{- printf "%s-backups-storage" (include "data.name" .) -}}
{{- end -}}

{{/* The ObjectStore (barmancloud.cnpg.io) the cluster archives to. */}}
{{- define "data.objectStore" -}}
{{- printf "%s-backups" (include "data.name" .) -}}
{{- end -}}

{{/* A role's Secret: app_api → db-app-api. */}}
{{- define "data.roleSecret" -}}
{{- $root := index . 0 -}}
{{- printf "%s%s" $root.Values.database.secretPrefix (index . 1 | replace "_" "-") -}}
{{- end -}}

{{/* The application roles (every role but the migrator, which owns the database). */}}
{{- define "data.appRoles" -}}
{{- without .Values.database.roles "migrator" | toJson -}}
{{- end -}}

{{/*
A hook that runs before the release's resources, under Helm (kind) and Argo CD alike.
Argo CD ignores the Helm annotations when its own are there; it runs it in the Sync
phase, ordered by wave, because a preview's namespace (a resource of this release)
must exist first.
*/}}
{{- define "data.preHook" -}}
helm.sh/hook: pre-install,pre-upgrade
helm.sh/hook-weight: {{ index . 1 | quote }}
helm.sh/hook-delete-policy: before-hook-creation
argocd.argoproj.io/hook: Sync
argocd.argoproj.io/sync-wave: {{ index . 1 | quote }}
argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
{{- end -}}

{{/*
A pod's security context: one unprivileged user and group for every data service, above
the node's own ids (so a container never shares one with a user of the machine), owning
the volumes it mounts (fsGroup), with the runtime's default seccomp profile. None of the
images needs a particular id: each writes only to its volumes and /tmp.
*/}}
{{- define "data.podSecurity" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* A container locked down for the restricted Pod Security Standard. */}}
{{- define "data.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

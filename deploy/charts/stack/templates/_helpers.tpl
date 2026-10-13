{{/*
Names, labels and the per-service configuration every template works from.
*/}}

{{- define "stack.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/* A service's resource name: <release>-<service>. */}}
{{- define "stack.fullname" -}}
{{- $root := index . 0 -}}
{{- printf "%s-%s" (include "stack.name" $root) (index . 1) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* A service's in-cluster host name. */}}
{{- define "stack.host" -}}
{{- $root := index . 0 -}}
{{- printf "%s.%s.svc.cluster.local" (include "stack.fullname" .) $root.Release.Namespace -}}
{{- end -}}

{{/* A service's in-cluster URL (http, on its port). */}}
{{- define "stack.url" -}}
{{- $root := index . 0 -}}
{{- $svc := include "stack.service" (list $root (index . 1)) | fromYaml -}}
{{- printf "http://%s:%v" (include "stack.host" .) $svc.port -}}
{{- end -}}

{{/* The public site's origin. */}}
{{- define "stack.siteUrl" -}}
{{- printf "%s://%s" .Values.site.scheme (required "site.host is required" .Values.site.host) -}}
{{- end -}}

{{- define "stack.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/part-of: {{ include "stack.name" $root }}
app.kubernetes.io/version: {{ $root.Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version }}
{{- end -}}

{{- define "stack.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/*
A service's settings: `defaults` with the service's own values merged over them
(maps merge key by key; lists and scalars replace).
*/}}
{{- define "stack.service" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $own := index $root.Values.services $name | default dict -}}
{{- mergeOverwrite (deepCopy $root.Values.defaults) (deepCopy $own) | toYaml -}}
{{- end -}}

{{/* The image a service runs. */}}
{{- define "stack.image" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- if $svc.imageRef -}}
{{- $svc.imageRef -}}
{{- else -}}
{{- printf "%s/%s:%s" $root.Values.image.registry $svc.image (required "image.tag is required" $root.Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* The Secret holding a service's other secrets (none for `secretFrom: none`). */}}
{{- define "stack.secretName" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $svc := index . 2 -}}
{{- $from := $svc.secretFrom | default $name -}}
{{- if ne $from "none" -}}
{{- include "stack.fullname" (list $root $from) -}}
{{- end -}}
{{- end -}}

{{/* The connection-URL Secret for a database role (app_api → db-app-api). */}}
{{- define "stack.dbSecret" -}}
{{- $root := index . 0 -}}
{{- printf "%s%s" $root.Values.database.secretPrefix (index . 1 | replace "_" "-") -}}
{{- end -}}

{{/*
A service's environment: shared settings, its own, where to send telemetry, its
database, Valkey and object storage details, and its Secret. Deployments and the jobs
that run a service's image (re-encryption) share it, so a job always sees what the
service sees.
*/}}
{{/* Postgres's certificate authority, for a service with a database (see database.caSecret). */}}
{{- define "stack.dbCaMount" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- if and $svc.database $root.Values.database.caSecret }}
- name: postgres-ca
  mountPath: /etc/postgres-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "stack.dbCaVolume" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- if and $svc.database $root.Values.database.caSecret }}
- name: postgres-ca
  secret:
    secretName: {{ $root.Values.database.caSecret }}
    items:
      - { key: ca.crt, path: ca.crt }
{{- end }}
{{- end -}}

{{- define "stack.containerEnv" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $svc := index . 2 -}}
{{- $telemetry := dict -}}
{{- with $root.Values.observability -}}
{{- if .enabled -}}
{{- $telemetry = dict "OTEL_EXPORTER_OTLP_ENDPOINT" .otlpEndpoint "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" .metricsEndpoint -}}
{{- end -}}
{{- end -}}
{{- /* Explicit settings win over the observability defaults. */ -}}
{{- $env := mergeOverwrite $telemetry (deepCopy $root.Values.env) ($svc.env | default dict) -}}
{{- if $svc.caBundle -}}
{{- /* Trusted besides the public CAs (the Deployment mounts it). */ -}}
{{- $_ := set $env "NODE_EXTRA_CA_CERTS" "/etc/ssl/extra/ca.crt" -}}
{{- end -}}
{{- $storage := $svc.storage | default "none" -}}
{{- $storageSecret := $root.Values.storage.secretName -}}
{{- $secret := include "stack.secretName" (list $root $name $svc) -}}
env:
  - name: RELEASE
    value: {{ $root.Values.image.tag | quote }}
  {{- range $key := keys $env | sortAlpha }}
  {{- $value := tpl (toString (index $env $key)) $root }}
  {{- /* An empty value means "not set", so the service applies its default. */}}
  {{- if ne $value "" }}
  - name: {{ $key }}
    value: {{ $value | quote }}
  {{- end }}
  {{- end }}
  {{- with $svc.database }}
  {{- $tls := $root.Values.database.caSecret }}
  {{- $keys := dict "url" "_DATABASE_URL" }}
  {{- if .directUrl }}{{ $_ := set $keys "directUrl" "_DATABASE_DIRECT_URL" }}{{ end }}
  {{- range $key := keys $keys | sortAlpha }}
  {{- $var := printf "%s%s" $svc.database.envPrefix (index $keys $key) }}
  {{- /* With TLS, the Secret's URL plus the verification settings ($(…) is expanded by Kubernetes). */}}
  - name: {{ ternary (printf "DATABASE_SECRET_%s" ($key | snakecase | upper)) $var (ne $tls "") }}
    valueFrom:
      secretKeyRef:
        name: {{ include "stack.dbSecret" (list $root $svc.database.role) }}
        key: {{ $key }}
  {{- if $tls }}
  - name: {{ $var }}
    value: {{ printf "$(DATABASE_SECRET_%s)?sslmode=verify-full&sslrootcert=/etc/postgres-ca/ca.crt" ($key | snakecase | upper) | quote }}
  {{- end }}
  {{- end }}
  {{- end }}
  {{- if $svc.redis }}
  - name: REDIS_URL
    valueFrom:
      secretKeyRef:
        name: {{ $root.Values.redis.secretName }}
        key: url
  {{- end }}
  {{- if eq $storage "origin" }}
  - name: STORAGE_ORIGIN
    valueFrom:
      secretKeyRef:
        name: {{ $storageSecret }}
        key: publicEndpoint
  {{- else if ne $storage "none" }}
  {{- /* Presigned URLs go to browsers, so they're signed for the public endpoint. */}}
  {{- $keys := dict
    "S3_BUCKET" "bucket"
    "S3_REGION" "region"
    "S3_ENDPOINT" (ternary "publicEndpoint" "endpoint" (eq $storage "presign"))
    "S3_ACCESS_KEY_ID" "accessKeyId"
    "S3_SECRET_ACCESS_KEY" "secretAccessKey" }}
  {{- range $var := keys $keys | sortAlpha }}
  - name: {{ $var }}
    valueFrom:
      secretKeyRef:
        name: {{ $storageSecret }}
        key: {{ index $keys $var }}
  {{- end }}
  # RustFS serves buckets by path, not as subdomains.
  - name: S3_FORCE_PATH_STYLE
    value: "true"
  {{- end }}
{{- if $secret }}
envFrom:
  - secretRef:
      name: {{ $secret }}
{{- end }}
{{- end -}}

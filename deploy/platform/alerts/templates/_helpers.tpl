{{- define "alerts.labels" -}}
app.kubernetes.io/name: alerts
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "alerts.emailDomain" -}}
{{- .Values.emailDomain | default (required "domain is required" .Values.domain) -}}
{{- end -}}

{{- define "alerts.mailHost" -}}
{{- .Values.mailHost | default (printf "mail.%s" (include "alerts.emailDomain" .)) -}}
{{- end -}}

{{/* A duration (30m, 36h, 14d) in seconds, for comparing with a metric. */}}
{{- define "alerts.seconds" -}}
{{- $units := dict "s" 1 "m" 60 "h" 3600 "d" 86400 -}}
{{- mul (regexFind "^[0-9]+" . | atoi) (index $units (regexFind "[smhd]$" .)) -}}
{{- end -}}
